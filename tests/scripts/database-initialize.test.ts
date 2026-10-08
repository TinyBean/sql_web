import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { initializeOeeDatabase } from "../../scripts/database/initialize.ts";
import { OeeDataStore } from "../../scripts/database/oee-data-store.ts";

test("initializes the OEE schema idempotently and preserves existing data", (t) => {
  const directory = mkdtempSync(path.join(tmpdir(), "sqlite-qa-init-"));
  const databasePath = path.join(directory, "database", "oee.sqlite");
  let reader: DatabaseSync | undefined;
  t.after(() => {
    reader?.close();
    rmSync(directory, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 50,
    });
  });

  initializeOeeDatabase(databasePath);
  const writer = new DatabaseSync(databasePath);
  writer.prepare(
    `INSERT INTO oee_availability (
       tool_name, lot_id, final_state, step, date, shift, time_span
     ) VALUES ('TOOL-1', 'LOT-1', 'Running', '1000', '2026-08-20T00:00:00Z', NULL, 60)`,
  ).run();
  writer.exec(
    "DROP TABLE oee_import_windows; DROP TABLE oee_import_runs; PRAGMA user_version = 0;",
  );
  writer.close();

  initializeOeeDatabase(databasePath);
  reader = new DatabaseSync(databasePath, { readOnly: true });

  assert.equal(reader.prepare("PRAGMA journal_mode").get()?.["journal_mode"], "wal");
  assert.equal(reader.prepare("SELECT COUNT(*) AS count FROM oee_availability").get()?.["count"], 1);
  assert.deepEqual(
    reader.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    ).all().map((row) => row["name"]),
    ["oee_availability", "oee_dut_utilization", "oee_import_runs", "oee_import_windows"],
  );
  assert.equal(reader.prepare("PRAGMA user_version").get()?.["user_version"], 3);
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

test("upgrades v2 without changing facts or historical audit and distrusts legacy DUT completeness", async (t) => {
  const directory = mkdtempSync(path.join(tmpdir(), "oee-v2-migration-"));
  const databasePath = path.join(directory, "oee.sqlite");
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const writer = new DatabaseSync(databasePath);
  const oldSchema = readFileSync(path.resolve("scripts/database/schema.sql"), "utf8")
    .replace(/^  (coverage_version|committed_dates_json|incomplete_dates_json|ignored_boundary_row_count).*\n/gmu, "")
    .replace("user_version = 3", "user_version = 2");
  writer.exec(oldSchema);
  writer.exec(`INSERT INTO oee_import_runs(id,command,parameters_json,status,owner_pid,started_at)
    VALUES('old','sync','{}','completed',0,'2026-01-03T00:00:00+08:00');
    INSERT INTO oee_dut_utilization(machine_id,lot_id,in_qty,out_qty,test_stage,dut_num,step_id,date,shift)
    VALUES('M1','old','10','9','1st','10','5000','2026-01-01T00:00:00.000Z','night');`);
  for (const [sequence, dataset, requested] of [[0, "availability", "2026-01-01"], [1, "dut_utilization", "2026-01-02"]]) {
    writer.prepare(`INSERT INTO oee_import_windows(id,run_id,sequence,dataset,source_kind,source_ref,
      requested_start_date,requested_end_date,expected_start_date,expected_end_date,status,rows_received)
      VALUES(?,'old',?,?,'api','old-api',?,?,'2026-01-01','2026-01-01','completed',1)`)
      .run(String(dataset), sequence!, dataset!, requested!, requested!);
  }
  const facts = writer.prepare("SELECT * FROM oee_dut_utilization").all();
  writer.close();
  initializeOeeDatabase(databasePath);
  initializeOeeDatabase(databasePath);
  const reader = new DatabaseSync(databasePath, { readOnly: true });
  assert.equal(reader.prepare("PRAGMA user_version").get()?.["user_version"], 3);
  assert.deepEqual(reader.prepare("SELECT * FROM oee_dut_utilization").all(), facts);
  assert.deepEqual(reader.prepare("SELECT status,coverage_version,committed_dates_json FROM oee_import_windows ORDER BY sequence")
    .all().map((row) => ({ ...row })), [0, 1].map(() => ({ status: "completed", coverage_version: 0, committed_dates_json: "[]" })));
  reader.close();
  const requests: string[] = [];
  const server = createServer((request, response) => {
    requests.push(request.url!);
    response.writeHead(503);
    response.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const store = OeeDataStore.open({ databasePath, apiBaseUrl: `http://127.0.0.1:${address.port}/`, fetchRetries: 0 });
  try {
    assert.deepEqual((await store.importNewDay({ dataset: "availability", date: "2026-01-01" })).datasets[0]?.plannedWindows, []);
    const dut = await store.importNewDay({ dataset: "dut_utilization", date: "2026-01-01" });
    assert.equal(dut.status, "failed");
    assert.deepEqual(dut.datasets[0]?.plannedWindows, [{ startDate: "2026-01-01", endDate: "2026-01-01" }]);
    assert.equal(requests.length, 1);
    assert.match(requests[0]!, /DUT_UTILIZATION/u);
  } finally {
    store.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
