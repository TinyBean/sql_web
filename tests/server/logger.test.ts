import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  DailyFileLogger,
  FileLogger,
  reportStartupError,
} from "../../src/server/logger.ts";

function readEntries(filename: string): unknown[] {
  return readFileSync(filename, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as unknown);
}

test("reports startup failures to the terminal", () => {
  const output: unknown[][] = [];
  const error = Object.assign(new Error("address already in use"), { code: "EADDRINUSE" });

  reportStartupError(error, (...data) => output.push(data));

  assert.deepEqual(output, [["数据库问答网站启动失败:", error]]);
});

test("writes Shanghai timestamps and rolls on the Shanghai calendar date", (t) => {
  const directory = mkdtempSync(path.join(tmpdir(), "sqlite-qa-logs-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));

  let now = new Date("2026-08-31T15:59:59.123Z");
  const logger = new DailyFileLogger(directory, { now: () => now, filenamePrefix: "sql_web" });
  logger.info("agent.prompt.started", { sessionId: "session-123" });

  now = new Date("2026-08-31T16:00:01.456Z");
  logger.error("agent.prompt.failed", new Error("provider unavailable"), {
    sessionId: "session-123",
  });

  assert.deepEqual(readdirSync(directory).sort(), [
    "sql_web-2026-08-31.log",
    "sql_web-2026-09-01.log",
  ]);
  const firstEntries = readEntries(path.join(directory, "sql_web-2026-08-31.log"));
  assert.deepEqual(firstEntries, [{
    timestamp: "2026-08-31T23:59:59.123+08:00",
    level: "INFO",
    event: "agent.prompt.started",
    pid: process.pid,
    fields: { sessionId: "session-123" },
  }]);

  const secondEntries = readEntries(path.join(directory, "sql_web-2026-09-01.log"));
  assert.equal(secondEntries.length, 1);
  const second = secondEntries[0] as {
    level: string;
    error: { name: string; message: string; stack: string };
  };
  assert.equal(second.level, "ERROR");
  assert.equal(second.error.name, "Error");
  assert.equal(second.error.message, "provider unavailable");
  assert.match(second.error.stack, /provider unavailable/u);
});

test("appends entries across dates to one fixed file", (t) => {
  const directory = mkdtempSync(path.join(tmpdir(), "sqlite-qa-fixed-logs-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));

  let now = new Date("2026-08-31T15:59:59.123Z");
  const filename = path.join(directory, "oee-data.log");
  const logger = new FileLogger(filename, { now: () => now });
  logger.info("oee.pull.started");
  now = new Date("2026-08-31T16:00:01.456Z");
  logger.info("oee.pull.completed");

  assert.deepEqual(readdirSync(directory), ["oee-data.log"]);
  const entries = readEntries(filename) as { event: string; timestamp: string }[];
  assert.deepEqual(entries.map((entry) => entry.event), [
    "oee.pull.started",
    "oee.pull.completed",
  ]);
  assert.deepEqual(entries.map((entry) => entry.timestamp), [
    "2026-08-31T23:59:59.123+08:00",
    "2026-09-01T00:00:01.456+08:00",
  ]);
});

test("inherits correlation context and serializes bounded error causes", (t) => {
  const directory = mkdtempSync(path.join(tmpdir(), "sqlite-qa-context-logs-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const filename = path.join(directory, "context.log");
  const logger = new FileLogger(filename)
    .child({ serviceRunId: "service-1" })
    .child({ requestId: "request-1" });
  const cause = Object.assign(new Error("database locked"), { code: "SQLITE_BUSY" });
  logger.error("http.request.failed", new Error("query failed", { cause }), { stage: "database" });

  const entry = readEntries(filename)[0] as {
    context: { serviceRunId: string; requestId: string };
    error: { message: string; cause: { message: string; code: string } };
  };
  assert.deepEqual(entry.context, {
    serviceRunId: "service-1",
    requestId: "request-1",
  });
  assert.equal(entry.error.message, "query failed");
  assert.equal(entry.error.cause.message, "database locked");
  assert.equal(entry.error.cause.code, "SQLITE_BUSY");
});

test("reports repeated file write failures only once until a write succeeds", (t) => {
  const directory = mkdtempSync(path.join(tmpdir(), "sqlite-qa-log-failure-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const errors: unknown[] = [];
  const logger = new FileLogger(directory, {
    reportWriteError: (error) => errors.push(error),
  });
  logger.info("first.write");
  logger.info("second.write");
  assert.equal(errors.length, 1);
});
