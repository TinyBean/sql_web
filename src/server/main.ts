import { randomUUID } from "node:crypto";
import path from "node:path";
import { loadConfig, loadProjectEnvironment, PROJECT_ROOT } from "./config.ts";
import { DailyFileLogger, reportStartupError } from "./logger.ts";
import type { AppLogger } from "./logger.ts";
import { startWebService } from "./service-runtime.ts";
import type { RunningWebService } from "./service-runtime.ts";

const rootLogger = new DailyFileLogger(path.join(PROJECT_ROOT, ".data", "logs"), {
  filenamePrefix: "sql_web",
});
const logger = rootLogger.child({ serviceRunId: randomUUID() });
const processStartedAt = Date.now();

process.on("uncaughtExceptionMonitor", (error, origin) => {
  logger.error(
    origin === "unhandledRejection" ? "system.unhandled_rejection" : "system.uncaught_exception",
    error,
    { stage: "process", origin, retryable: false },
  );
});
process.once("exit", (exitCode) => {
  logger.info("system.exited", {
    stage: "process",
    exitCode,
    durationMs: Date.now() - processStartedAt,
  });
});

async function loadApplicationConfig(log: AppLogger) {
  const startedAt = Date.now();
  log.info("system.stage.started", { stage: "config" });
  try {
    const config = loadConfig(loadProjectEnvironment());
    log.info("system.stage.completed", {
      stage: "config",
      durationMs: Date.now() - startedAt,
      host: config.host,
      port: config.port,
      databasePath: config.databasePath,
      provider: config.model.provider,
      model: config.model.model,
    });
    return config;
  } catch (error) {
    log.error("system.stage.failed", error, {
      stage: "config",
      durationMs: Date.now() - startedAt,
      retryable: false,
    });
    throw error;
  }
}

logger.info("system.starting", { stage: "process" });

let runtime: RunningWebService | undefined;
try {
  const config = await loadApplicationConfig(logger);
  runtime = await startWebService(config, logger);
  console.log(`数据库问答网站已启动:http://${config.host}:${config.port}`);
  console.log(`日志:${config.logDir}/sql_web-YYYY-MM-DD.log`);
} catch (error) {
  logger.error("system.start_failed", error, {
    stage: "startup",
    durationMs: Date.now() - processStartedAt,
    retryable: false,
  });
  reportStartupError(error);
  process.exitCode = 1;
}

if (runtime) {
  let requestedExitCode = 0;
  let stopPromise: Promise<void> | undefined;
  const stop = (reason: string, exitCode: number): Promise<void> => {
    requestedExitCode = Math.max(requestedExitCode, exitCode);
    if (stopPromise) return stopPromise;
    stopPromise = (async () => {
      const result = await runtime!.shutdown(reason);
      if (result.failed) requestedExitCode = 1;
      process.exit(requestedExitCode);
    })();
    return stopPromise;
  };

  runtime.server.on("error", (error) => {
    logger.error("system.server.error", error, {
      stage: "http_listener",
      retryable: false,
    });
    void stop("server_error", 1);
  });
  process.once("SIGINT", () => {
    logger.info("system.signal.received", { stage: "process", signal: "SIGINT" });
    void stop("SIGINT", 0);
  });
  process.once("SIGTERM", () => {
    logger.info("system.signal.received", { stage: "process", signal: "SIGTERM" });
    void stop("SIGTERM", 0);
  });
}
