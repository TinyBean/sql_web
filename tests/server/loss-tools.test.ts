import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test, { type TestContext } from "node:test";
import { initializeOeeDatabase } from "../../scripts/database/initialize.ts";
import { AppDatabase } from "../../src/server/database/database.ts";
import { AnalysisEvidence } from "../../src/server/dashboard/default/analysis/evidence.ts";
import { createAnalysisTools } from "../../src/server/dashboard/default/analysis/tools.ts";
import { createDefaultDashboard } from "../../src/server/dashboard/default/template.ts";
import { SessionDashboardStore } from "../../src/server/dashboard/session-store.ts";
import { ArtifactStore } from "../../src/server/tool/artifact-store.ts";
import { CodeInterpreterRuntime } from "../../src/server/tool/code-interpreter.ts";
import { createAgentTools } from "../../src/server/tool/database-tools.ts";
import { measureLoss } from "../../src/server/tool/loss-tools.ts";

const sessionId = "loss-test-session";
const range = { start_date: "2026-01-01", end_date: "2026-01-03" };

function fixture(t: TestContext) {
  const directory = mkdtempSync(path.join(tmpdir(), "loss-tools-"));
  const databasePath = path.join(directory, "oee.sqlite");
  initializeOeeDatabase(databasePath);
  const writer = new DatabaseSync(databasePath);
  const insert = writer.prepare("INSERT INTO oee_availability(tool_name,lot_id,final_state,step,date,time_span) VALUES(?,?,?,?,?,?)");
  insert.run("MT-01", "P1", "Conversion", "5000", "2026-01-01", 3600);
  insert.run("MT-02", "P1", "Conversion", "5000", "2026-01-01", 7200);
  insert.run("MT-02", "P1", "Test(Normal)", "5000", "2026-01-02", 3600);
  insert.run("ST-01", "P1", "Conversion", "7000", "2026-01-03T08:30:00", 10800);
  // Invalid LOT, excluded platform, unknown type and out-of-range rows must not contribute.
  insert.run("MT-01", "X1", "Conversion", "5000", "2026-01-03", 360000);
  insert.run("TSPH001", "P1", "Conversion", "5000", "2026-01-03", 360000);
  insert.run("UNKNOWN", "P1", "Conversion", "1000", "2026-01-03", 360000);
  insert.run("MT-01", "P1", "Conversion", "5000", "2026-01-04", 360000);
  const database = AppDatabase.open({ filePath: databasePath });
  const store = new ArtifactStore(path.join(directory, "artifacts"));
  const artifacts = store.forSession(sessionId);
  t.after(() => { database.close(); writer.close(); rmSync(directory, { recursive: true, force: true }); });
  return { directory, databasePath, writer, database, store, artifacts };
}

test("standard losses preserve canonical filtering, inclusive dates and type-wide coverage", (t) => {
  const { database, artifacts } = fixture(t);
  const measured = measureLoss(database, artifacts, range);
  assert.deepEqual(measured.rows.map((row) => [row["kind"], row["loss_hours"], row["kind_availability_days"], row["observed_days"], row["selected_days"]]), [
    ["MT", 3, 2, 1, 3], ["ST", 3, 1, 1, 3],
  ]);
  assert.equal(measured.rows[0]?.["hours_per_kind_available_day"], 1.5);
  assert.equal(measured.rows[0]?.["hours_per_selected_day"], 1);
  const filtered = measureLoss(database, artifacts, { ...range, states: ["Conversion"], machines: ["MT-01"], by_machine: true });
  assert.equal(filtered.rows.length, 1);
  assert.equal(filtered.rows[0]?.["machine"], "MT-01");
  assert.equal(filtered.rows[0]?.["loss_hours"], 1);
  assert.equal(filtered.rows[0]?.["kind_availability_days"], 2, "loss filters do not reduce the coverage denominator");
  assert.equal(filtered.rows[0]?.["hours_per_kind_available_day"], 0.5);
  assert.equal(measureLoss(database, artifacts, { ...range, states: ["Machine_Running"] }).rows.length, 0);
  assert.equal(measureLoss(database, artifacts, { ...range, machines: ["MT-01') OR 1=1 --"] }).rows.length, 0);
});

test("loss snapshots survive restoration, never replace earlier measurements, and feed dashboards", async (t) => {
  const { database, writer, store, artifacts, directory } = fixture(t);
  const first = measureLoss(database, artifacts, range);
  writer.prepare("UPDATE oee_availability SET time_span=time_span*2").run();
  const restored = new ArtifactStore(store.rootDir).forSession(sessionId);
  const second = measureLoss(database, restored, range);
  assert.equal(first.snapshot.name, "loss-20260101-20260103");
  assert.equal(second.snapshot.name, first.snapshot.name + "-2");
  assert.notEqual(second.snapshot.version, first.snapshot.version);
  assert.equal(second.rows[0]?.["loss_hours"], 6);
  const frozen = JSON.parse(readFileSync(restored.resolveDataSnapshot(first.snapshot.name).filePath, "utf8"));
  assert.deepEqual(frozen.rows, first.rows);
  assert.throws(() => store.forSession("other-test-session").resolveDataSnapshot(first.snapshot.name), /不存在/u);
  const dashboard = new SessionDashboardStore(store, createDefaultDashboard);
  const baseline = dashboard.loadOrInitialize(sessionId);
  const result = dashboard.apply(sessionId, {
    action: "upsert", baseRevision: baseline.revision, snapshot: first.snapshot.name,
    dateRange: { start: range.start_date, end: range.end_date },
    widget: {
      id: "measured-loss", kind: "table", title: "状态损失", subtitle: "标准口径", size: "wide",
      encoding: { columns: [{ key: "kind", label: "类型" }, { key: "loss_hours", label: "损失小时" }] },
      format: { unit: "小时", precision: 1 }, metricDefinition: "按业务日查询标准损失", warnings: [],
    },
  });
  assert.deepEqual(result.dashboard.widgets.at(-1)?.data.map((row) => row["loss_hours"]), [3, 3]);
  await store.deleteSession(sessionId);
  assert.equal(existsSync(path.join(directory, "artifacts", sessionId)), false);
});

test("chat and daily tools share schemas, rows and views while only daily registers audit evidence", async (t) => {
  const { directory, databasePath, database, artifacts, store } = fixture(t);
  const runtime = await CodeInterpreterRuntime.create({
    pythonPath: path.join(directory, "missing-python"), bwrapPath: "/missing-bwrap", prlimitPath: "/missing-prlimit", projectRoot: directory,
  });
  t.after(() => runtime.dispose());
  assert.equal(runtime.status.available, false);
  const reader = new DatabaseSync(databasePath, { readOnly: true });
  t.after(() => reader.close());
  reader.exec("BEGIN");
  const auditArtifacts = store.forSession("daily-test-session");
  const evidence = new AnalysisEvidence(reader, undefined, auditArtifacts);
  const chat = createAgentTools(database, artifacts, runtime).find((tool) => tool.name === "measure_loss")!;
  const daily = createAnalysisTools(evidence, runtime).find((tool) => tool.name === "measure_loss")!;
  assert.deepEqual(chat.parameters, daily.parameters);
  assert.equal(chat.description, daily.description);
  const chatResult = await chat.execute("chat", { ...range, by_machine: true }, undefined, undefined, undefined as never);
  const dailyResult = await daily.execute("daily", { ...range, by_machine: true }, undefined, undefined, undefined as never);
  const a = JSON.parse(chatResult.content.find((part) => part.type === "text")!.text);
  const b = JSON.parse(dailyResult.content.find((part) => part.type === "text")!.text);
  assert.deepEqual(a.view, b.view);
  assert.deepEqual(a.scope, b.scope);
  assert.deepEqual(a.range, b.range);
  assert.equal(a.evidence_id, undefined);
  assert.equal(evidence.records.get(b.evidence_id)?.source, "measure_loss");
  assert.deepEqual(evidence.records.get(b.evidence_id)?.rows, JSON.parse(readFileSync(artifacts.resolveDataSnapshot(a.snapshot.name).filePath, "utf8")).rows);
  const sql = createAnalysisTools(evidence, runtime).find((tool) => tool.name === "execute_sql")!;
  await assert.rejects(() => sql.execute("overwrite", { sql: "SELECT 0", save_as: b.snapshot.name }, undefined, undefined, undefined as never), /已固定/u);
});

test("invalid or cancelled measurements do not create snapshots", (t) => {
  const { database, artifacts, directory } = fixture(t);
  for (const params of [
    { start_date: "2026-02-30", end_date: "2026-03-01" },
    { start_date: "2026-01-02", end_date: "2026-01-01" },
    { start_date: "2026-1-1", end_date: "2026-01-03" },
  ]) assert.throws(() => measureLoss(database, artifacts, params), /日期|晚于/u);
  assert.throws(() => measureLoss(database, artifacts, range, AbortSignal.abort()), /abort/iu);
  assert.deepEqual(artifacts.listDataSnapshots(), []);
  assert.equal(existsSync(path.join(directory, "artifacts", sessionId)), false);
});

test("row and byte overflow remove partial files and preserve existing snapshots", (t) => {
  const { database, writer, artifacts, directory } = fixture(t);
  const previous = measureLoss(database, artifacts, range);
  const files = readdirSync(path.join(directory, "artifacts", sessionId)).sort();
  for (const [count, prefix, expected] of [[100001, "M", /行数/u], [17000, "M".repeat(2200), /字节/u]] as const) {
    writer.exec("DELETE FROM oee_availability");
    writer.prepare(`WITH RECURSIVE n(i) AS (VALUES(1) UNION ALL SELECT i+1 FROM n WHERE i<?)
      INSERT INTO oee_availability(tool_name,lot_id,final_state,step,date,time_span)
      SELECT ? || i,'P1','Conversion','5000','2026-01-01',3600 FROM n`).run(count, prefix);
    assert.throws(() => measureLoss(database, artifacts, { ...range, by_machine: true }), expected);
    assert.deepEqual(artifacts.listDataSnapshots(), [previous.snapshot]);
    assert.deepEqual(readdirSync(path.join(directory, "artifacts", sessionId)).sort(), files);
  }
});
