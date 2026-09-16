import { createDefaultDashboard } from "../../src/server/dashboard/default/template.ts";
import type { DashboardRow } from "../../src/shared/dashboard.ts";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { Value } from "typebox/value";
import {
  DashboardConflictError,
  DashboardInputError,
  SessionDashboardStore,
  type DashboardWidgetRequest,
} from "../../src/server/dashboard/session-store.ts";
import { createDashboardTools } from "../../src/server/tool/dashboard-tools.ts";
import { ArtifactStore } from "../../src/server/tool/artifact-store.ts";

const SESSION_A = "session-dashboard-a";
const SESSION_B = "session-dashboard-b";
const DEFAULT_WIDGET_IDS = [
  "mt-oee-overview",
  "st-oee-overview",
  "oee-trend-weekly-2026",
  "oee-trend-monthly-2026",
  "oee-trend-quarterly-2026",
  "oee-extremes-table-2026",
  "mt-st-components-2026",
  "improvement-actions-week-2026",
  "improvement-actions-month-2026",
  "improvement-actions-quarter-2026",
];

function fixture(t: TestContext): {
  readonly directory: string;
  readonly artifacts: ArtifactStore;
  readonly dashboard: SessionDashboardStore;
} {
  const directory = mkdtempSync(path.join(tmpdir(), "sqlite-qa-dashboard-"));
  const artifacts = new ArtifactStore(path.join(directory, "artifacts"));
  t.after(() => {
    rmSync(directory, { recursive: true, force: true });
  });
  return {
    directory,
    artifacts,
    dashboard: new SessionDashboardStore(artifacts, createDefaultDashboard),
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

test("previews a default dashboard without creating session artifacts", (t) => {
  const { dashboard, artifacts } = fixture(t);
  const sessionDirectory = path.join(artifacts.rootDir, SESSION_A);

  const first = dashboard.loadOrPreview(SESSION_A);
  assert.equal(first.revision, 0);
  assert.deepEqual(first.widgets.map((widget) => widget.id), DEFAULT_WIDGET_IDS);
  assert.equal(existsSync(sessionDirectory), false);

  const second = dashboard.loadOrPreview(SESSION_A);
  assert.equal(second.revision, 0);
  assert.deepEqual(second, first);
  assert.notEqual(second.widgets[0]?.data, first.widgets[0]?.data);
  assert.equal(existsSync(sessionDirectory), false);
});

test("initializes and restores the pinned ten-card dashboard per session", (t) => {
  const { dashboard, artifacts } = fixture(t);
  const first = dashboard.loadOrInitialize(SESSION_A);
  assert.equal(first.revision, 0);
  assert.deepEqual(first.widgets.map((widget) => widget.id), DEFAULT_WIDGET_IDS);
  assert.equal(first.widgets.every((widget) => widget.warnings.length > 0), true);
  assert.deepEqual(dashboard.loadOrInitialize(SESSION_A), first);
  assert.deepEqual(new SessionDashboardStore(artifacts, createDefaultDashboard).loadOrInitialize(SESSION_A), first);

  const document = JSON.parse(
    readFileSync(path.join(artifacts.rootDir, SESSION_A, "dashboard.json"), "utf8"),
  ) as { baseline: unknown; current: unknown };
  assert.deepEqual(document.baseline, document.current);
  assert.deepEqual(dashboard.loadOrInitialize(SESSION_B), first);
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
  const original = baseline.widgets.find((widget) => widget.id === "mt-oee-overview");
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
      id: "mt-oee-overview",
      kind: "kpi",
      title: "Overall OEE",
      subtitle: "上周",
      encoding: { value: "oee_pct", comparison: null },
      format: { unit: "%", precision: 2 },
      metric_definition: "Test OEE = Availability × Performance × Yield",
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
  const updated = current.widgets.find((widget) => widget.id === "mt-oee-overview");
  assert.equal(updated?.size, original.size);
  assert.deepEqual(updated?.data, [{ oee_pct: 23.95 }]);
});

test("preserves the source metrics and layout with empty fallback analysis", (t) => {
  const { dashboard } = fixture(t);
  const state = dashboard.loadOrInitialize(SESSION_A);
  assert.equal(state.dataAsOf, "2026-09-15T02:03:34.568Z");
  assert.deepEqual(state.dateRange, { start: "2026-01-01", end: "2026-09-14" });
  assert.deepEqual(state.widgets.map((widget) => widget.size), [
    "wide", "wide", "wide", "wide", "wide", "medium", "wide", "medium", "medium", "medium",
  ]);
  const overview = state.widgets[0];
  assert.ok(overview?.kind === "overview");
  assert.equal(overview.data[0]?.["overall_oee_percent"], 51.55133290776901);
  assert.equal(overview.encoding.label, "Overall OEE");
  assert.equal(overview.encoding.gauges.length, 3);

  const trends = state.widgets.slice(2, 5);
  assert.deepEqual(trends.map((widget) => widget.data.length), [37, 9, 3]);
  for (const trend of trends) {
    assert.ok(trend.kind === "line");
    assert.deepEqual(trend.encoding.series.map((series) => series.column), [
      "oee_percent", "max_point", "min_point",
    ]);
    assert.equal(trend.data.filter((row) => row["max_point"] !== null).length, 1);
    assert.equal(trend.data.filter((row) => row["min_point"] !== null).length, 1);
  }
  assert.equal(trends[0]?.data[0]?.["period_label"], "2026-W00");
  assert.equal(state.widgets[5]?.data.length, 6);
  const machines = state.widgets[6]!;
  assert.equal(machines.kind, "table");
  assert.equal(machines.title, "OEE 机台 TOP10（周/月/季）· 极值单项对应");
  assert.equal(machines.data.length, 6);
  for (const row of machines.data) {
    const original: DashboardRow | undefined = state.widgets[5]!.data.find((item) =>
      item["grain"] === row["grain"] && item["point_type"] === row["point_type"]);
    assert.equal(row["period_label"], original?.["period_label"]);
    assert.equal(row["oee_percent"], original?.["oee_percent"]);
  }
  const actions = state.widgets.slice(7);
  assert.deepEqual(actions.map((widget) => widget.title), [
    "改善措施与责任人 · 周（W36）",
    "改善措施与责任人 · 月（2026-09）",
    "改善措施与责任人 · 季（2026-Q3）",
  ]);
  for (const action of actions) {
    assert.equal(action.kind, "table");
    assert.deepEqual(action.data, []);
    assert.ok(action.warnings.some((warning) => warning.includes("本次分析暂不可用")));
    assert.ok(action.warnings.some((warning) => warning.includes("责任人列为职能建议")));
  }
});

test("an edit before initialization uses the pinned baseline and reset restores it", (t) => {
  const { dashboard, artifacts } = fixture(t);
  const preview = dashboard.loadOrPreview(SESSION_A);
  const edited = dashboard.apply(SESSION_A, {
    action: "remove",
    baseRevision: 0,
    widgetId: "oee-trend-weekly-2026",
  }).dashboard;
  assert.equal(edited.widgets.length, 9);
  const restarted = new SessionDashboardStore(artifacts, createDefaultDashboard);
  assert.deepEqual(restarted.loadOrPreview(SESSION_A), edited);
  assert.deepEqual(restarted.loadOrInitialize(SESSION_B), preview);
  const reset = restarted.apply(SESSION_A, { action: "reset", baseRevision: 1 }).dashboard;
  assert.deepEqual(reset, { ...preview, revision: 2 });
});

test("keeps existing saved dashboards and their reset baseline", (t) => {
  const { dashboard, artifacts } = fixture(t);
  const initial = dashboard.loadOrInitialize(SESSION_A);
  const baseline = { ...initial, widgets: initial.widgets.slice(0, 1) };
  const current = { ...baseline, revision: 7, widgets: [] };
  writeFileSync(path.join(artifacts.rootDir, SESSION_A, "dashboard.json"), JSON.stringify({
    schemaVersion: 1,
    baseline,
    current,
  }));
  const restarted = new SessionDashboardStore(artifacts, createDefaultDashboard);
  assert.deepEqual(restarted.loadOrPreview(SESSION_A), current);
  assert.deepEqual(restarted.loadOrInitialize(SESSION_A), current);
  assert.deepEqual(
    restarted.apply(SESSION_A, { action: "reset", baseRevision: 7 }).dashboard,
    { ...baseline, revision: 8 },
  );
  assert.deepEqual(restarted.loadOrInitialize(SESSION_B).widgets.map((widget) => widget.id), DEFAULT_WIDGET_IDS);
});
