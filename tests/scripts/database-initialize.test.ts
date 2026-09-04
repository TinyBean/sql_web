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
    `INSERT INTO oee_availability (
       tool_name, lot_id, final_state, step, date, shift, time_span
     ) VALUES ('TOOL-1', 'LOT-1', 'Running', '1000', '2026-08-20T00:00:00Z', NULL, 60)`,
  ).run();
  writer.close();

  initializeOeeDatabase(databasePath);
  const reader = new DatabaseSync(databasePath, { readOnly: true });
  t.after(() => reader.close());

  assert.equal(reader.prepare("PRAGMA journal_mode").get()?.["journal_mode"], "wal");
  assert.equal(reader.prepare("SELECT COUNT(*) AS count FROM oee_availability").get()?.["count"], 1);
  assert.deepEqual(
    reader.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    ).all().map((row) => row["name"]),
    ["oee_availability", "oee_dut_utilization"],
  );
  const availabilityColumns = reader.prepare("PRAGMA table_info('oee_availability')").all();
  assert.deepEqual(
    availabilityColumns.map((column) => column["name"]),
    ["id", "tool_name", "lot_id", "final_state", "step", "date", "shift", "time_span"],
  );
  assert.deepEqual(
    availabilityColumns.map((column) => column["pk"]),
    [1, 0, 0, 0, 0, 0, 0, 0],
  );
  const dutColumns = reader.prepare("PRAGMA table_info('oee_dut_utilization')").all();
  assert.equal(dutColumns.length, 38);
  assert.deepEqual(dutColumns.filter((column) => column["notnull"] === 1).map((column) => column["name"]), [
    "machine_id", "lot_id", "in_qty", "out_qty", "test_stage", "dut_num", "step_id",
  ]);
  assert.deepEqual(dutColumns.filter((column) => column["pk"] === 1).map((column) => column["name"]), ["id"]);
});
