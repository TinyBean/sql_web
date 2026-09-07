import type { Server } from "node:http";
import path from "node:path";
import { AgentSessionStore } from "./agent/agent-sessions.ts";
import type { AppConfig } from "./config.ts";
import { AppDatabase } from "./database/database.ts";
import { createWebServer } from "./http-server.ts";
import type { WebDatabasePort, WebSessionPort } from "./http-server.ts";
import type { AppLogger } from "./logger.ts";
import { ArtifactStore } from "./tool/artifact-store.ts";
import { CodeInterpreterRuntime } from "./tool/code-interpreter.ts";

const SHUTDOWN_TIMEOUT_MS = 5_000;

export interface ServiceShutdownResult {
  readonly failed: boolean;
  readonly timedOut: boolean;
}

export interface RunningWebService {
  readonly server: Server;
  shutdown(reason: string): Promise<ServiceShutdownResult>;
}

interface RuntimeDatabase extends WebDatabasePort {
  close(): void;
}

interface RuntimeCodeInterpreter {
  readonly status: { readonly available: boolean; readonly reason: string | null };
  dispose(): void;
}

interface RuntimeSessions extends WebSessionPort {
  dispose(): void;
}

interface OpenRuntimeSessionsOptions {
  readonly database: RuntimeDatabase;
  readonly artifacts: unknown;
  readonly codeInterpreter: RuntimeCodeInterpreter;
  readonly config: AppConfig;
  readonly logger: AppLogger;
}

export interface ServiceRuntimeDependencies {
  readonly shutdownTimeoutMs?: number;
  openDatabase(filePath: string): RuntimeDatabase;
  createArtifacts(directory: string): unknown;
  createCodeInterpreter(config: AppConfig): Promise<RuntimeCodeInterpreter>;
  openSessions(options: OpenRuntimeSessionsOptions): Promise<RuntimeSessions>;
  createServer(options: {
    readonly database: RuntimeDatabase;
    readonly sessions: RuntimeSessions;
    readonly config: AppConfig;
    readonly logger: AppLogger;
  }): Server;
}

const DEFAULT_DEPENDENCIES: ServiceRuntimeDependencies = {
  openDatabase: (filePath) => AppDatabase.open({ filePath }),
  createArtifacts: (directory) => new ArtifactStore(directory),
  createCodeInterpreter: (config) => CodeInterpreterRuntime.create({
    ...config.codeInterpreter,
    projectRoot: config.projectRoot,
  }),
  openSessions: ({ database, artifacts, codeInterpreter, config, logger }) =>
    AgentSessionStore.open({
      database: database as AppDatabase,
      artifacts: artifacts as ArtifactStore,
      codeInterpreter: codeInterpreter as CodeInterpreterRuntime,
      cwd: config.projectRoot,
      sessionDir: config.sessionDir,
      agentDir: config.agentDir,
      model: config.model,
      logger,
    }),
  createServer: ({ database, sessions, config, logger }) => createWebServer({
    database,
    sessions,
    publicDir: config.publicDir,
    vendorDir: path.join(config.projectRoot, "node_modules"),
    logger,
  }),
};

async function runStage<T>(
  logger: AppLogger,
  stage: string,
  operation: () => T | Promise<T>,
): Promise<T> {
  const startedAt = Date.now();
  logger.info("system.stage.started", { stage });
  try {
    const result = await operation();
    logger.info("system.stage.completed", { stage, durationMs: Date.now() - startedAt });
    return result;
  } catch (error) {
    logger.error("system.stage.failed", error, {
      stage,
      durationMs: Date.now() - startedAt,
      retryable: false,
    });
    throw error;
  }
}

async function listen(server: Server, port: number, host: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => reject(error);
    server.once("error", onError);
    server.listen(port, host, () => {
      server.off("error", onError);
      resolve();
    });
  });
}

export async function startWebService(
  config: AppConfig,
  logger: AppLogger,
  dependencies: ServiceRuntimeDependencies = DEFAULT_DEPENDENCIES,
): Promise<RunningWebService> {
  const startedAt = Date.now();
  let database: RuntimeDatabase | undefined;
  let codeInterpreter: RuntimeCodeInterpreter | undefined;
  let sessions: RuntimeSessions | undefined;
  let server: Server | undefined;

  try {
    const openedDatabase = await runStage(logger, "database", () =>
      dependencies.openDatabase(config.databasePath));
    database = openedDatabase;
    const artifacts = await runStage(logger, "artifacts", () =>
      dependencies.createArtifacts(config.artifactDir));
    const createdCodeInterpreter = await runStage(logger, "code_interpreter", () =>
      dependencies.createCodeInterpreter(config));
    codeInterpreter = createdCodeInterpreter;
    if (createdCodeInterpreter.status.available) {
      logger.info("code_interpreter.available", {
        stage: "code_interpreter",
        pythonPath: config.codeInterpreter.pythonPath,
      });
    } else {
      logger.warn("code_interpreter.unavailable", {
        stage: "code_interpreter",
        reason: createdCodeInterpreter.status.reason,
      });
    }
    const createdSessions = await runStage(logger, "agent_store", () => dependencies.openSessions({
      database: openedDatabase,
      artifacts,
      codeInterpreter: createdCodeInterpreter,
      config,
      logger,
    }));
    sessions = createdSessions;
    server = await runStage(logger, "http_listener", async () => {
      const createdServer = dependencies.createServer({
        database: openedDatabase,
        sessions: createdSessions,
        config,
        logger,
      });
      await listen(createdServer, config.port, config.host);
      return createdServer;
    });
  } catch (error) {
    if (server?.listening) server.close();
    if (sessions) {
      try {
        sessions.dispose();
      } catch (cleanupError) {
        logger.error("system.cleanup.failed", cleanupError, { stage: "agent_store" });
      }
    } else if (codeInterpreter) {
      try {
        codeInterpreter.dispose();
      } catch (cleanupError) {
        logger.error("system.cleanup.failed", cleanupError, { stage: "code_interpreter" });
      }
    }
    if (database) {
      try {
        database.close();
      } catch (cleanupError) {
        logger.error("system.cleanup.failed", cleanupError, { stage: "database" });
      }
    }
    throw error;
  }

  const activeServer = server;
  const activeSessions = sessions;
  const activeDatabase = database;
  logger.info("system.started", {
    host: config.host,
    port: config.port,
    durationMs: Date.now() - startedAt,
  });

  let shutdownPromise: Promise<ServiceShutdownResult> | undefined;
  return {
    server: activeServer,
    shutdown(reason: string): Promise<ServiceShutdownResult> {
      if (shutdownPromise) return shutdownPromise;
      shutdownPromise = (async () => {
        const shutdownStartedAt = Date.now();
        let failed = false;
        let timedOut = false;
        logger.info("system.stopping", { reason });

        logger.info("system.stage.started", { stage: "http_listener", action: "shutdown" });
        const closeCompleted = new Promise<void>((resolve) => {
          if (!activeServer.listening) {
            resolve();
            return;
          }
          activeServer.close((error) => {
            if (error) {
              failed = true;
              logger.error("system.stage.failed", error, { stage: "http_listener" });
            } else {
              logger.info("system.stage.completed", {
                stage: "http_listener",
                durationMs: Date.now() - shutdownStartedAt,
              });
            }
            resolve();
          });
        });
        let timeout: NodeJS.Timeout | undefined;
        await Promise.race([
          closeCompleted,
          new Promise<void>((resolve) => {
            timeout = setTimeout(() => {
              timedOut = true;
              failed = true;
              logger.error(
                "system.shutdown.timeout",
                new Error(`服务未能在 ${dependencies.shutdownTimeoutMs ?? SHUTDOWN_TIMEOUT_MS} 毫秒内关闭`),
                { stage: "http_listener", reason, durationMs: Date.now() - shutdownStartedAt },
              );
              activeServer.closeAllConnections();
              resolve();
            }, dependencies.shutdownTimeoutMs ?? SHUTDOWN_TIMEOUT_MS).unref();
          }),
        ]);
        if (timeout) clearTimeout(timeout);

        for (const [stage, cleanup] of [
          ["agent_store", () => activeSessions.dispose()],
          ["database", () => activeDatabase.close()],
        ] as const) {
          const cleanupStartedAt = Date.now();
          logger.info("system.stage.started", { stage, action: "shutdown" });
          try {
            cleanup();
            logger.info("system.stage.completed", {
              stage,
              action: "shutdown",
              durationMs: Date.now() - cleanupStartedAt,
            });
          } catch (error) {
            failed = true;
            logger.error("system.stage.failed", error, {
              stage,
              action: "shutdown",
              durationMs: Date.now() - cleanupStartedAt,
              retryable: false,
            });
          }
        }
        logger.info("system.stopped", {
          reason,
          failed,
          timedOut,
          durationMs: Date.now() - shutdownStartedAt,
        });
        return { failed, timedOut };
      })();
      return shutdownPromise;
    },
  };
}
