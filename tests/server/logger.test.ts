import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { DailyFileLogger, FileLogger } from "../../src/server/logger.ts";

function readEntries(filename: string): unknown[] {
  return readFileSync(filename, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as unknown);
}

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
