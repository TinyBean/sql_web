import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { Value } from "typebox/value";
import { initializeOeeDatabase } from "../../scripts/database/initialize.ts";
import {
  DashboardConflictError,
  DashboardInputError,
  DashboardModule,
  type DashboardWidgetRequest,
} from "../../src/server/tool/dashboard.ts";
import { createDashboardTools } from "../../src/server/tool/dashboard-tools.ts";
import { AppDatabase } from "../../src/server/database/database.ts";
import { ArtifactStore } from "../../src/server/tool/artifact-store.ts";

const SESSION_A = "session-dashboard-a";
const SESSION_B = "session-dashboard-b";

function fixture(t: TestContext): {
  readonly directory: string;
  readonly databasePath: string;
  readonly database: AppDatabase;
  readonly artifacts: ArtifactStore;
  readonly dashboard: DashboardModule;
} {
  const directory = mkdtempSync(path.join(tmpdir(), "sqlite-qa-dashboard-"));
  const databasePath = path.join(directory, "oee.sqlite");
  initializeOeeDatabase(databasePath);
  const database = AppDatabase.open({ filePath: databasePath });
  const artifacts = new ArtifactStore(path.join(directory, "artifacts"));
  t.after(() => {
    database.close();
    rmSync(directory, { recursive: true, force: true });
  });
  return {
    directory,
    databasePath,
    database,
    artifacts,
    dashboard: new DashboardModule(database, artifacts),
  };
}

function createSnapshot(
  artifacts: ArtifactStore,
  sessionId: string,
  name: string,
  rows: readonly Record<string, string | number | null>[],
): string {
  const columns = Object.keys(rows[0] ?? {});
  const payload = JSON.stringify({ columns, rows, rowCount: rows.length, truncated: false });
  return artifacts.forSession(sessionId).createDataSnapshot(name, (fileDescriptor) => {
    writeSync(fileDescriptor, payload);
    return { columns, rowCount: rows.length };
  }).name;
}

function lineRequest(id = "yield-7d"): DashboardWidgetRequest {
  return {
    id,
    kind: "line",
    title: "MT / ST Yield",
    subtitle: "最近 7 天",
    size: "wide",
    encoding: {
      category: "date",
      series: [{ name: "MT", column: "mt" }, { name: "ST", column: "st" }],
    },
    format: { unit: "%", precision: 1 },
    metricDefinition: "Yield = SUM(OUT_QTY) / SUM(IN_QTY)",
    warnings: [],
  };
}

test("initializes and restores a frozen six-widget dashboard per session", (t) => {
  const { dashboard, artifacts } = fixture(t);
  const first = dashboard.loadOrInitialize(SESSION_A);
  assert.equal(first.revision, 0);
  assert.deepEqual(first.widgets.map((widget) => widget.id), [
    "mt-test-oee",
    "st-test-oee",
    "oee-components",
    "oee-trend-14d",
    "availability-top10",
    "data-coverage",
  ]);
  assert.equal(first.widgets.every((widget) => widget.warnings.length > 0), true);
  assert.deepEqual(dashboard.loadOrInitialize(SESSION_A), first);

  const document = JSON.parse(
    readFileSync(path.join(artifacts.rootDir, SESSION_A, "dashboard.json"), "utf8"),
  ) as { baseline: unknown; current: unknown };
  assert.deepEqual(document.baseline, document.current);
  assert.equal(dashboard.loadOrInitialize(SESSION_B).widgets.length, 6);
});

test("materializes one session snapshot atomically and rejects stale revisions", (t) => {
  const { dashboard, artifacts } = fixture(t);
  const baseline = dashboard.loadOrInitialize(SESSION_A);
  const snapshot = createSnapshot(artifacts, SESSION_A, "yield 7d", [
    { date: "2026-09-01", mt: 91.2, st: 88.5, ignored: "server-only" },
    { date: "2026-09-02", mt: 92.1, st: 89.4, ignored: "server-only" },
  ]);
  const applied = dashboard.apply(SESSION_A, {
    action: "upsert",
    baseRevision: baseline.revision,
    snapshot,
    dateRange: { start: "2026-09-01", end: "2026-09-02" },
    widget: lineRequest(),
  });
  assert.equal(applied.dashboard.revision, 1);
  assert.deepEqual(applied.dashboard.widgets.at(-1)?.data, [
    { date: "2026-09-01", mt: 91.2, st: 88.5 },
    { date: "2026-09-02", mt: 92.1, st: 89.4 },
  ]);
  assert.throws(
    () => dashboard.apply(SESSION_A, {
      action: "remove",
      baseRevision: 0,
      widgetId: "yield-7d",
    }),
    DashboardConflictError,
  );
  assert.equal(dashboard.loadOrInitialize(SESSION_A).revision, 1);
  assert.equal(dashboard.loadOrInitialize(SESSION_B).widgets.some((item) => item.id === "yield-7d"), false);

  const reset = dashboard.apply(SESSION_A, { action: "reset", baseRevision: 1 });
  assert.equal(reset.dashboard.revision, 2);
  assert.deepEqual(reset.dashboard.widgets, baseline.widgets);
});

test("validates snapshot shape and emits only a transient full update plus compact result", async (t) => {
  const { dashboard, artifacts } = fixture(t);
  dashboard.loadOrInitialize(SESSION_A);
  const snapshot = createSnapshot(artifacts, SESSION_A, "yield single", [
    { date: "2026-09-01", mt: 90, st: 80 },
  ]);
  assert.throws(
    () => dashboard.apply(SESSION_A, {
      action: "upsert",
      baseRevision: 0,
      snapshot,
      dateRange: { start: "2026-09-01", end: "2026-09-01" },
      widget: {
        ...lineRequest(),
        encoding: { category: "missing", series: [{ name: "MT", column: "mt" }] },
      } as DashboardWidgetRequest,
    }),
    DashboardInputError,
  );
  assert.equal(dashboard.loadOrInitialize(SESSION_A).revision, 0);

  const tools = createDashboardTools(dashboard, SESSION_A);
  const update = tools.find((tool) => tool.name === "update_dashboard");
  assert.ok(update);
  const updates: unknown[] = [];
  const result = await update.execute(
    "dashboard-call",
    {
      action: "upsert",
      base_revision: 0,
      snapshot,
      date_range: { start: "2026-09-01", end: "2026-09-01" },
      widget: {
        ...lineRequest(),
        metric_definition: lineRequest().metricDefinition,
      },
    } as never,
    undefined,
    (partial) => updates.push(partial),
    undefined as never,
  );
  const details = result.details as { kind: string; revision: number; changedWidgetIds: string[]; pointCount: number };
  assert.deepEqual(details, {
    kind: "dashboard_summary",
    revision: 1,
    changedWidgetIds: ["yield-7d"],
    pointCount: 1,
  });
  assert.equal(JSON.stringify(result).includes('"data"'), false);
  assert.match(JSON.stringify(updates), /dashboard_update/u);
  assert.match(JSON.stringify(updates), /"yield-7d"/u);
});

test("accepts stringified model-server arguments and preserves an existing widget size", async (t) => {
  const { dashboard, artifacts } = fixture(t);
  const baseline = dashboard.loadOrInitialize(SESSION_A);
  const original = baseline.widgets.find((widget) => widget.id === "mt-test-oee");
  assert.ok(original);
  const snapshot = createSnapshot(artifacts, SESSION_A, "mt oee compatibility", [
    { oee_pct: 23.95 },
  ]);
  const tools = createDashboardTools(dashboard, SESSION_A);
  const update = tools.find((tool) => tool.name === "update_dashboard");
  assert.ok(update);
  const arguments_ = {
    action: "upsert",
    base_revision: "0",
    snapshot,
    date_range: JSON.stringify({ start: "2026-08-31", end: "2026-09-06" }),
    widget: JSON.stringify({
      id: "mt-test-oee",
      kind: "kpi",
      title: "MT Test OEE",
      subtitle: "上周",
      encoding: { value: "oee_pct", comparison: null },
      format: { unit: "%", precision: 2 },
      metric_definition: "Test OEE = Availability × DUT-On × 1 × Yield",
      warnings: ["Availability 缺失三天"],
    }),
  };
  assert.equal(Value.Check(update.parameters, arguments_), true);

  await update.execute(
    "dashboard-stringified-call",
    arguments_ as never,
    undefined,
    undefined,
    undefined as never,
  );

  const current = dashboard.loadOrInitialize(SESSION_A);
  assert.equal(current.revision, 1);
  assert.deepEqual(current.dateRange, { start: "2026-08-31", end: "2026-09-06" });
  const updated = current.widgets.find((widget) => widget.id === "mt-test-oee");
  assert.equal(updated?.size, original.size);
  assert.deepEqual(updated?.data, [{ oee_pct: 23.95 }]);
});

test("builds the 14-day MT/ST OEE fixture with complete-day denominators", (t) => {
  const { databasePath, dashboard } = fixture(t);
  const writer = new DatabaseSync(databasePath);
  const availability = writer.prepare(
    "INSERT INTO oee_availability(tool_name,lot_id,final_state,step,date,time_span) VALUES(?,?,?,?,?,?)",
  );
  const dut = writer.prepare(
    "INSERT INTO oee_dut_utilization(machine_id,lot_id,in_qty,out_qty,test_stage,dut_num,step_id,date) VALUES(?,?,?,?,?,?,?,?)",
  );
  for (let day = 26; day <= 31; day += 1) {
    const date = `2026-08-${String(day).padStart(2, "0")}`;
    availability.run("MT-01", "P-MT", "Test(Normal)", "5000", date, 43_200);
    availability.run("ST-01", "P-ST", "Test(Normal)", "7000", date, 43_200);
    dut.run("MT-01", "P-MT", "10", "8", "1st", "20", "5000", date);
    dut.run("ST-01", "P-ST", "10", "8", "1st", "20", "7000", date);
  }
  for (let day = 1; day <= 8; day += 1) {
    const date = `2026-09-${String(day).padStart(2, "0")}`;
    availability.run("MT-01", "P-MT", "Test(Normal)", "5000", date, 43_200);
    availability.run("ST-01", "P-ST", "Test(Normal)", "7000", date, 43_200);
    dut.run("MT-01", "P-MT", "10", "8", "1st", "20", "5000", date);
    dut.run("ST-01", "P-ST", "10", "8", "1st", "20", "7000", date);
  }
  availability.run("MT-01", "P-MT", "Test(Normal)", "5000", "2026-09-09", 43_200);
  writer.close();

  const state = dashboard.loadOrInitialize("session-fixed-fixture");
  assert.deepEqual(state.dateRange, { start: "2026-08-26", end: "2026-09-08" });
  for (const id of ["mt-test-oee", "st-test-oee"]) {
    const widget = state.widgets.find((item) => item.id === id);
    assert.equal(widget?.data[0]?.["value"], 20);
  }
  assert.equal(state.widgets.find((item) => item.id === "oee-trend-14d")?.data.length, 14);
  assert.equal(state.widgets.find((item) => item.id === "availability-top10")?.data[0]?.["availability"], 50);
  assert.equal(state.widgets.find((item) => item.id === "data-coverage")?.warnings.length, 0);
});
