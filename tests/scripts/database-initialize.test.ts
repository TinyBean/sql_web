import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { initializeOeeDatabase } from "../../scripts/database/initialize.ts";

test("initializes the OEE schema idempotently and preserves existing data", (t) => {
  const directory = mkdtempSync(path.join(tmpdir(), "sqlite-qa-init-"));
  const databasePath = path.join(directory, "database", "oee.sqlite");
  t.after(() => rmSync(directory, { recursive: true, force: true }));

  initializeOeeDatabase(databasePath);
  const writer = new DatabaseSync(databasePath);
  writer.prepare(
    `INSERT INTO oee_ingestion_runs (
       dataset, source_kind, source_ref, requested_start_date, requested_end_date, status, started_at
     ) VALUES ('availability', 'file', 'fixture.json', '2026-08-20', '2026-08-20', 'running', '2026-09-02T00:00:00Z')`,
  ).run();
  writer.close();

  initializeOeeDatabase(databasePath);
  const reader = new DatabaseSync(databasePath, { readOnly: true });
  t.after(() => reader.close());

  assert.equal(reader.prepare("PRAGMA journal_mode").get()?.["journal_mode"], "wal");
  assert.equal(reader.prepare("SELECT COUNT(*) AS count FROM oee_ingestion_runs").get()?.["count"], 1);
});
