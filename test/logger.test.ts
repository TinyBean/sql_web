import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { DailyFileLogger } from "../src/logger.ts";

function readEntries(filename: string): unknown[] {
  return readFileSync(filename, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as unknown);
}

test("writes structured entries and rolls to a new file on the local date", (t) => {
  const directory = mkdtempSync(path.join(tmpdir(), "sqlite-qa-logs-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));

  let now = new Date(2026, 7, 31, 23, 59, 59);
  const logger = new DailyFileLogger(directory, { now: () => now });
  logger.info("agent.prompt.started", { sessionId: "session-123" });

  now = new Date(2026, 8, 1, 0, 0, 1);
  logger.error("agent.prompt.failed", new Error("provider unavailable"), {
    sessionId: "session-123",
  });

  assert.deepEqual(readdirSync(directory).sort(), [
    "sql-web-2026-08-31.log",
    "sql-web-2026-09-01.log",
  ]);
  const firstEntries = readEntries(path.join(directory, "sql-web-2026-08-31.log"));
  assert.deepEqual(firstEntries, [{
    timestamp: new Date(2026, 7, 31, 23, 59, 59).toISOString(),
    level: "INFO",
    event: "agent.prompt.started",
    pid: process.pid,
    fields: { sessionId: "session-123" },
  }]);

  const secondEntries = readEntries(path.join(directory, "sql-web-2026-09-01.log"));
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
