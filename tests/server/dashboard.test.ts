import { createDefaultDashboard } from "../../src/server/dashboard/default/template.ts";
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
} from "../../src/server/agent/session-dashboard.ts";
import { createDashboardTools } from "../../src/server/tool/dashboard-tools.ts";
import { ArtifactStore } from "../../src/server/tool/artifact-store.ts";

const SESSION_A = "session-dashboard-a";
const SESSION_B = "session-dashboard-b";
const DEFAULT_WIDGET_IDS = [
  "mt-effective-oee-overview",
  "mt-oee-overview",
  "st-effective-oee-overview",
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
    dashboard: new SessionDashboardStore(artifacts, () => createDefaultDashboard(new Date("2026-09-22T01:00:00Z"))),
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

test("initializes and restores the pinned twelve-card dashboard per session", (t) => {
  const { dashboard, artifacts } = fixture(t);
  const first = dashboard.loadOrInitialize(SESSION_A);
  assert.equal(first.revision, 0);
  assert.deepEqual(first.widgets.map((widget) => widget.id), DEFAULT_WIDGET_IDS);
  assert.equal(first.widgets.every((widget) => widget.warnings.length > 0), true);
  assert.deepEqual(dashboard.loadOrInitialize(SESSION_A), first);
  assert.deepEqual(new SessionDashboardStore(artifacts, () => createDefaultDashboard()).loadOrInitialize(SESSION_A), first);

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

test("empty templates retain the twelve-card layout and isolate each snapshot", () => {
  const now = new Date("2026-09-22T01:00:00.000Z");
  const state = createDefaultDashboard(now);
  assert.equal(state.dataAsOf, now.toISOString());
  assert.deepEqual(state.dateRange, { start: null, end: null });
  assert.deepEqual(state.widgets.map((widget) => widget.id), DEFAULT_WIDGET_IDS);
  assert.deepEqual(state.widgets.map((widget) => widget.size), [
    "medium", "medium", "medium", "medium", "wide", "wide", "wide", "medium", "wide", "medium", "medium", "medium",
  ]);
  for (const widget of state.widgets) {
    assert.ok(widget.warnings.some((warning) => warning.includes("等待每日任务")));
    assert.doesNotMatch(widget.title + widget.subtitle + widget.metricDefinition, /2026-/u);
    if (widget.kind === "overview") {
      assert.ok(Object.values(widget.data[0]!).every((value) => value === null));
      assert.equal(widget.encoding.gauges.length, 4);
    } else {
      assert.deepEqual(widget.data, []);
    }
  }
  const independent = createDefaultDashboard(now);
  Reflect.set(state.widgets[0]!.data[0]!, "overall_effective_oee_percent", 99);
  Reflect.set(state.widgets[0]!.format, "precision", 0);
  assert.deepEqual(createDefaultDashboard(now), independent);
  assert.equal(createDefaultDashboard(new Date("2026-09-23T01:00:00Z")).dataAsOf, "2026-09-23T01:00:00.000Z");
});

test("an edit before initialization uses the pinned baseline and reset restores it", (t) => {
  const { dashboard, artifacts } = fixture(t);
  const preview = dashboard.loadOrPreview(SESSION_A);
  const edited = dashboard.apply(SESSION_A, {
    action: "remove",
    baseRevision: 0,
    widgetId: "oee-trend-weekly-2026",
  }).dashboard;
  assert.equal(edited.widgets.length, 11);
  const later = new Date("2026-09-23T01:00:00Z");
  const restarted = new SessionDashboardStore(artifacts, () => createDefaultDashboard(later));
  assert.deepEqual(restarted.loadOrPreview(SESSION_A), edited);
  assert.deepEqual(restarted.loadOrInitialize(SESSION_B), { ...preview, dataAsOf: later.toISOString() });
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
  const restarted = new SessionDashboardStore(artifacts, () => createDefaultDashboard());
  assert.deepEqual(restarted.loadOrPreview(SESSION_A), current);
  assert.deepEqual(restarted.loadOrInitialize(SESSION_A), current);
  assert.deepEqual(
    restarted.apply(SESSION_A, { action: "reset", baseRevision: 7 }).dashboard,
    { ...baseline, revision: 8 },
  );
  assert.deepEqual(restarted.loadOrInitialize(SESSION_B).widgets.map((widget) => widget.id), DEFAULT_WIDGET_IDS);
});

test("the twelve-card default allows two additions and fourteen-card tool reordering, but rejects a fifteenth", async (t) => {
  const { dashboard, artifacts } = fixture(t);
  const snapshot = createSnapshot(artifacts, SESSION_A, "extra metrics", [{ date: "2026-09-01", mt: 90, st: 80 }]);
  const dateRange = { start: "2026-09-01", end: "2026-09-01" };
  for (const [index, id] of ["extra-a", "extra-b"].entries()) {
    const result = dashboard.apply(SESSION_A, { action: "upsert", baseRevision: index, snapshot, dateRange, widget: lineRequest(id) });
    assert.equal(result.dashboard.widgets.length, 13 + index);
  }
  const update = createDashboardTools(dashboard, SESSION_A).find((tool) => tool.name === "update_dashboard")!;
  const widgetIds = dashboard.loadOrInitialize(SESSION_A).widgets.map((widget) => widget.id).reverse();
  const arguments_ = { action: "reorder", base_revision: 2, widget_ids: widgetIds };
  assert.equal(Value.Check(update.parameters, arguments_), true);
  assert.equal(Value.Check(update.parameters, { ...arguments_, widget_ids: [...widgetIds, "extra-c"] }), false);
  await update.execute("reorder-fourteen", arguments_ as never, undefined, undefined, undefined as never);
  assert.deepEqual(dashboard.loadOrInitialize(SESSION_A).widgets.map((widget) => widget.id), widgetIds);
  assert.throws(() => dashboard.apply(SESSION_A, {
    action: "upsert", baseRevision: 3, snapshot, dateRange, widget: lineRequest("extra-c"),
  }), /最多包含 14 个组件/u);
  assert.equal(dashboard.loadOrInitialize(SESSION_A).revision, 3);
  // Updating an existing card at capacity still works.
  assert.equal(dashboard.apply(SESSION_A, {
    action: "upsert", baseRevision: 3, snapshot, dateRange, widget: lineRequest("extra-a"),
  }).dashboard.widgets.length, 14);
});
