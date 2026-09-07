import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import type { AppConfig } from "../../src/server/config.ts";
import type { AppLogger, LogContext, LogFields } from "../../src/server/logger.ts";
import {
  startWebService,
  type ServiceRuntimeDependencies,
} from "../../src/server/service-runtime.ts";

interface LogEntry {
  readonly level: string;
  readonly event: string;
  readonly context: LogContext;
  readonly fields?: LogFields;
}

class MemoryLogger implements AppLogger {
  readonly entries: LogEntry[];
  readonly context: LogContext;

  constructor(
    entries: LogEntry[] = [],
    context: LogContext = {},
  ) {
    this.entries = entries;
    this.context = context;
  }

  info(event: string, fields?: LogFields): void {
    this.entries.push({ level: "INFO", event, context: this.context, ...(fields ? { fields } : {}) });
  }

  warn(event: string, fields?: LogFields): void {
    this.entries.push({ level: "WARN", event, context: this.context, ...(fields ? { fields } : {}) });
  }

  error(event: string, _error: unknown, fields?: LogFields): void {
    this.entries.push({ level: "ERROR", event, context: this.context, ...(fields ? { fields } : {}) });
  }

  child(context: LogContext): AppLogger {
    return new MemoryLogger(this.entries, { ...this.context, ...context });
  }
}

function fixtureConfig(directory: string): AppConfig {
  return {
    projectRoot: directory,
    host: "127.0.0.1",
    port: 0,
    databasePath: path.join(directory, "database.sqlite"),
    sessionDir: path.join(directory, "sessions"),
    artifactDir: path.join(directory, "artifacts"),
    publicDir: directory,
    agentDir: path.join(directory, "agent"),
    logDir: path.join(directory, "logs"),
    model: { provider: "test", model: "test" },
    codeInterpreter: {
      pythonPath: "/usr/bin/python3",
      bwrapPath: "/usr/bin/bwrap",
      prlimitPath: "/usr/bin/prlimit",
    },
  };
}

function fakeDependencies(events: string[]): ServiceRuntimeDependencies {
  return {
    openDatabase: (filePath) => ({
      filePath,
      getSchema: () => [],
      close: () => events.push("database.close"),
    }),
    createArtifacts: () => ({}),
    createCodeInterpreter: async () => ({
      status: { available: true, reason: null },
      dispose: () => events.push("interpreter.dispose"),
    }),
    openSessions: async () => ({
      status: () => ({
        tools: [],
        codeInterpreter: { available: true, reason: null },
        model: { provider: "test", model: "test" },
        availableModelCount: 1,
        activeSessionCount: 0,
      }),
      list: async () => [],
      create: async () => {
        throw new Error("not used");
      },
      get: async () => {
        throw new Error("not used");
      },
      getSerialized: async () => {
        throw new Error("not used");
      },
      delete: async () => {},
      prompt: async () => {},
      abort: async () => {},
      dispose: () => events.push("sessions.dispose"),
    }),
    createServer: () => createServer(),
  };
}

test("cleans initialized resources in reverse order when startup fails", async (t) => {
  const directory = mkdtempSync(path.join(tmpdir(), "service-runtime-failure-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const events: string[] = [];
  const logger = new MemoryLogger();
  const dependencies = fakeDependencies(events);
  dependencies.openSessions = async () => {
    throw new Error("agent store unavailable");
  };

  await assert.rejects(
    startWebService(fixtureConfig(directory), logger, dependencies),
    /agent store unavailable/u,
  );
  assert.deepEqual(events, ["interpreter.dispose", "database.close"]);
  assert.equal(
    logger.entries.some((entry) =>
      entry.event === "system.stage.failed" && entry.fields?.["stage"] === "agent_store"),
    true,
  );
});

test("attributes early and late startup failures to the correct stage", async (t) => {
  const directory = mkdtempSync(path.join(tmpdir(), "service-runtime-stages-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));

  for (const scenario of ["database", "artifacts", "code_interpreter", "http_listener"] as const) {
    await t.test(scenario, async () => {
      const events: string[] = [];
      const logger = new MemoryLogger();
      const dependencies = fakeDependencies(events);
      if (scenario === "database") dependencies.openDatabase = () => { throw new Error(scenario); };
      else if (scenario === "artifacts") dependencies.createArtifacts = () => { throw new Error(scenario); };
      else if (scenario === "code_interpreter") {
        dependencies.createCodeInterpreter = async () => { throw new Error(scenario); };
      } else dependencies.createServer = () => { throw new Error(scenario); };

      await assert.rejects(
        startWebService(fixtureConfig(directory), logger, dependencies),
        new RegExp(scenario, "u"),
      );
      assert.equal(
        logger.entries.some((entry) =>
          entry.event === "system.stage.failed" && entry.fields?.["stage"] === scenario),
        true,
      );
    });
  }
});

test("shuts a running service down once and releases sessions before the database", async (t) => {
  const directory = mkdtempSync(path.join(tmpdir(), "service-runtime-shutdown-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const events: string[] = [];
  const logger = new MemoryLogger();
  const runtime = await startWebService(
    fixtureConfig(directory),
    logger,
    fakeDependencies(events),
  );

  const [first, second] = await Promise.all([
    runtime.shutdown("SIGTERM"),
    runtime.shutdown("duplicate"),
  ]);
  assert.deepEqual(first, { failed: false, timedOut: false });
  assert.deepEqual(second, first);
  assert.deepEqual(events, ["sessions.dispose", "database.close"]);
  assert.equal(logger.entries.filter((entry) => entry.event === "system.stopped").length, 1);
});

test("forces open connections closed after the shutdown deadline", async (t) => {
  const directory = mkdtempSync(path.join(tmpdir(), "service-runtime-timeout-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const events: string[] = [];
  const dependencies: ServiceRuntimeDependencies = {
    ...fakeDependencies(events),
    shutdownTimeoutMs: 5,
    createServer: () => {
      const server = createServer();
      const originalClose = server.close.bind(server);
      server.close = (() => server) as typeof server.close;
      server.closeAllConnections = () => {
        events.push("server.force-close");
        originalClose();
      };
      return server;
    },
  };
  const runtime = await startWebService(
    fixtureConfig(directory),
    new MemoryLogger(),
    dependencies,
  );
  const result = await runtime.shutdown("timeout-test");
  assert.deepEqual(result, { failed: true, timedOut: true });
  assert.deepEqual(events, ["server.force-close", "sessions.dispose", "database.close"]);
});
