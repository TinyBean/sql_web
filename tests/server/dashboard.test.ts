import { createDefaultDashboard } from "../../src/server/dashboard/default/template.ts";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { Value } from "typebox/value";
import {
  DashboardConflictError,
  DashboardInputError,
  SessionDashboardStore,
  type DashboardData,
  type DashboardWidgetRequest,
} from "../../src/server/agent/session-dashboard.ts";
import { createDashboardTools } from "../../src/server/tool/dashboard-tools.ts";
import { ArtifactStore } from "../../src/server/tool/artifact-store.ts";
import { MAX_DASHBOARD_FILE_BYTES, MAX_DASHBOARD_ROWS_PER_WIDGET } from "../../src/shared/dashboard.ts";

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
  "improvement-actions-day-2026",
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

function chartData(rows: DashboardData["rows"]): DashboardData {
  return { columns: Object.keys(rows[0] ?? {}), rows };
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

test("new table/chart machine labels include platforms while original data IDs and values remain intact", (t) => {
  const { dashboard } = fixture(t);
  const rows = [{ machine: "ADH001", oee: 30 }, { machine: "ADH161", oee: 50 }];
  const data = chartData(rows);
  const baseline = dashboard.loadOrInitialize(SESSION_A);
  const first = dashboard.apply(SESSION_A, { action: "upsert", baseRevision: baseline.revision, data,
    dateRange: { start: "2026-01-01", end: "2026-01-01" }, widget: {
      id: "machine-values", kind: "table", size: "medium", title: "ADH001 等机台", subtitle: "本日机台值",
      encoding: { columns: [{ key: "machine", label: "机台" }, { key: "oee", label: "OEE%" }] },
      format: { unit: "%", precision: 2 }, metricDefinition: "机台指标", warnings: [],
    } });
  const table = first.dashboard.widgets.at(-1)!;
  assert.equal(table.kind, "table"); if (table.kind !== "table") return;
  const displayColumn = table.encoding.columns[0]!.key;
  assert.deepEqual(table.data.map((row) => row[displayColumn]), ["T5773/ADH001", "平台待维护/ADH161"]);
  assert.deepEqual(table.data.map((row) => [row["machine"], row["oee"]]), [["ADH001", 30], ["ADH161", 50]]);
  assert.equal(table.title, "T5773/ADH001 等机台");
  const second = dashboard.apply(SESSION_A, { action: "upsert", baseRevision: first.dashboard.revision, data,
    dateRange: { start: "2026-01-01", end: "2026-01-01" }, widget: {
      id: "machine-chart", kind: "bar", size: "medium", title: "机台指标", subtitle: "本日",
      encoding: { category: "machine", series: [{ name: "OEE", column: "oee" }], orientation: "vertical" },
      format: { unit: "%", precision: 2 }, metricDefinition: "机台指标", warnings: [],
    } });
  const chart = second.dashboard.widgets.at(-1)!;
  assert.equal(chart.kind, "bar"); if (chart.kind !== "bar") return;
  assert.deepEqual(chart.data.map((row) => row[chart.encoding.category]), ["T5773/ADH001", "平台待维护/ADH161"]);
  assert.deepEqual(data.rows, [{ machine: "ADH001", oee: 30 }, { machine: "ADH161", oee: 50 }]);
});

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

test("initializes and restores the pinned thirteen-card dashboard per session", (t) => {
  const { dashboard, artifacts } = fixture(t);
  const first = dashboard.loadOrInitialize(SESSION_A);
  assert.equal(first.revision, 0);
  assert.deepEqual(first.widgets.map((widget) => widget.id), DEFAULT_WIDGET_IDS);
  assert.equal(first.widgets.every((widget) => widget.warnings.length > 0), true);
  assert.deepEqual(dashboard.loadOrInitialize(SESSION_A), first);
  assert.deepEqual(new SessionDashboardStore(artifacts, () => createDefaultDashboard()).loadOrInitialize(SESSION_A), first);

  const document = JSON.parse(
    readFileSync(path.join(artifacts.rootDir, SESSION_A, "dashboard.json"), "utf8"),
  ) as { dashboards: { baseline: unknown; current: unknown }[] };
  assert.deepEqual(document.dashboards[0]!.baseline, document.dashboards[0]!.current);
  assert.deepEqual(dashboard.loadOrInitialize(SESSION_B), first);
});

test("materializes chart data atomically and rejects stale revisions", (t) => {
  const { dashboard } = fixture(t);
  const baseline = dashboard.loadOrInitialize(SESSION_A);
  const data = chartData([
    { date: "2026-09-01", mt: 91.2, st: 88.5, ignored: "server-only" },
    { date: "2026-09-02", mt: 92.1, st: 89.4, ignored: "server-only" },
  ]);
  const applied = dashboard.apply(SESSION_A, {
    action: "upsert",
    baseRevision: baseline.revision,
    data,
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

test("validates chart data and emits only a transient full update plus compact result", async (t) => {
  const { dashboard } = fixture(t);
  dashboard.loadOrInitialize(SESSION_A);
  const data = chartData([
    { date: "2026-09-01", mt: 90, st: 80 },
  ]);
  assert.throws(
    () => dashboard.apply(SESSION_A, {
      action: "upsert",
      baseRevision: 0,
      data,
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
      dashboard_id: "default", base_revision: 0,
      data,
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
    dashboardId: "default",
    revision: 1,
    changedWidgetIds: ["yield-7d"],
    pointCount: 1,
  });
  assert.equal(JSON.stringify(result).includes('"data"'), false);
  assert.match(JSON.stringify(updates), /dashboard_update/u);
  assert.match(JSON.stringify(updates), /"yield-7d"/u);
});

test("accepts stringified model-server arguments and preserves an existing widget size", async (t) => {
  const { dashboard } = fixture(t);
  const baseline = dashboard.loadOrInitialize(SESSION_A);
  const original = baseline.widgets.find((widget) => widget.id === "mt-oee-overview");
  assert.ok(original);
  const data = chartData([
    { oee_pct: 23.95 },
  ]);
  const tools = createDashboardTools(dashboard, SESSION_A);
  const update = tools.find((tool) => tool.name === "update_dashboard");
  assert.ok(update);
  const arguments_ = {
    action: "upsert",
    dashboard_id: "default", base_revision: "0",
    data: JSON.stringify(data),
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

test("direct data updates neither require nor read a snapshot manifest", async (t) => {
  const { dashboard, artifacts } = fixture(t);
  const update = createDashboardTools(dashboard, SESSION_A)[1];
  const sessionDirectory = path.join(artifacts.rootDir, SESSION_A);
  const manifestPath = path.join(sessionDirectory, "snapshots.json");
  const data = chartData([{ date: "2026-09-01", mt: 90.123456789, st: null }]);
  const arguments_ = {
    action: "upsert", dashboard_id: "default", base_revision: 0, data,
    date_range: { start: "2026-09-01", end: "2026-09-01" },
    widget: { ...lineRequest(), metric_definition: lineRequest().metricDefinition },
  };
  const before = Date.now();
  await update.execute("no-manifest", arguments_ as never, undefined, undefined, undefined as never);
  const first = dashboard.loadOrPreview(SESSION_A);
  assert.ok(Date.parse(first.dataAsOf) >= before && Date.parse(first.dataAsOf) <= Date.now());
  assert.deepEqual(first.widgets.at(-1)?.data, data.rows);
  assert.deepEqual(readdirSync(sessionDirectory), ["dashboard.json"]);

  writeFileSync(manifestPath, "broken snapshot index");
  t.mock.method(artifacts, "forSession", () => { assert.fail("dashboard updates must not resolve session snapshots"); });
  await update.execute("broken-manifest", { ...arguments_, base_revision: 1 } as never, undefined, undefined, undefined as never);
  assert.equal(dashboard.loadOrPreview(SESSION_A).revision, 2);
  assert.equal(readFileSync(manifestPath, "utf8"), "broken snapshot index");
  assert.deepEqual(readdirSync(sessionDirectory).sort(), ["dashboard.json", "snapshots.json"]);
});

test("invalid direct data and mappings preserve the persisted dashboard and revision", (t) => {
  const { dashboard, artifacts } = fixture(t);
  const baseline = dashboard.loadOrInitialize(SESSION_A);
  const filePath = path.join(artifacts.rootDir, SESSION_A, "dashboard.json");
  const original = readFileSync(filePath, "utf8");
  const valid = { date: "2026-09-01", mt: 90, st: 80 };
  const cases: readonly [string, unknown, RegExp][] = [
    ["missing data", undefined, /数据结构无效/u],
    ["missing rows", { columns: ["date", "mt", "st"] }, /数据结构无效/u],
    ["duplicate columns", { columns: ["date", "mt", "mt"], rows: [valid] }, /数据结构无效/u],
    ["empty column", { columns: ["date", "mt", ""], rows: [valid] }, /数据结构无效/u],
    ["blank column", { columns: ["date", "mt", " "], rows: [valid] }, /数据结构无效/u],
    ["missing mapped column", { columns: ["date", "mt"], rows: [valid] }, /不存在列 st/u],
    ["missing row field", { columns: ["date", "mt", "st"], rows: [{ date: valid.date, mt: 90 }] }, /缺少列 st/u],
    ["array row", { columns: ["date", "mt", "st"], rows: [[valid.date, 90, 80]] }, /不是对象/u],
    ["null row", { columns: ["date", "mt", "st"], rows: [null] }, /不是对象/u],
    ["numeric string", chartData([{ ...valid, mt: "90" }]), /必须是数字或 null/u],
    ["boolean cell", { columns: ["date", "mt", "st"], rows: [{ ...valid, mt: true }] }, /不是可展示标量/u],
    ["nested unused cell", { columns: ["date", "mt", "st"], rows: [{ ...valid, extra: {} }] }, /不是可展示标量/u],
    ["NaN", chartData([{ ...valid, mt: Number.NaN }]), /不是可展示标量/u],
    ["Infinity", chartData([{ ...valid, mt: Number.POSITIVE_INFINITY }]), /不是可展示标量/u],
    ["row limit", chartData(Array.from({ length: MAX_DASHBOARD_ROWS_PER_WIDGET + 1 }, () => valid)), /不能超过 2000 行/u],
    ["UTF-8 byte limit", chartData([{ ...valid, unused: "中".repeat(700_000) }]), /不能超过 2097152 字节/u],
  ];
  for (const [name, data, expected] of cases) {
    assert.throws(() => dashboard.apply(SESSION_A, {
      action: "upsert", baseRevision: 0, data: data as DashboardData,
      dateRange: { start: valid.date, end: valid.date }, widget: lineRequest(),
    }), expected, name);
    assert.equal(readFileSync(filePath, "utf8"), original, name);
    assert.deepEqual(dashboard.loadOrPreview(SESSION_A), baseline, name);
  }
  assert.throws(() => dashboard.apply(SESSION_A, {
    action: "upsert", baseRevision: 0, data: chartData([valid]),
    dateRange: { start: "2026-09-02", end: "2026-09-01" }, widget: lineRequest(),
  }), /开始日期不晚于结束日期/u);
  assert.throws(() => dashboard.apply(SESSION_A, {
    action: "upsert", baseRevision: 0,
    data: chartData([{ ...valid, date: "x".repeat(MAX_DASHBOARD_FILE_BYTES - 1200) }]),
    dateRange: { start: valid.date, end: valid.date }, widget: lineRequest(),
  }), /单个看板文件不能超过/u);
  assert.equal(readFileSync(filePath, "utf8"), original);
});

test("empty trends and maximum-size row sets work, while KPI and overview require exactly one row", (t) => {
  const { dashboard } = fixture(t);
  const dateRange = { start: null, end: null };
  const empty = { columns: ["date", "mt", "st"], rows: [] };
  const first = dashboard.apply(SESSION_A, {
    action: "upsert", baseRevision: 0, data: empty, dateRange, widget: lineRequest(),
  });
  assert.equal(first.pointCount, 0);
  for (const kind of ["kpi", "overview"] as const) {
    const widget: DashboardWidgetRequest = kind === "kpi"
      ? { ...lineRequest(), kind, encoding: { value: "mt", comparison: "st" } }
      : { ...lineRequest(), kind, encoding: { value: "mt", gauges: [{ name: "ST", column: "st" }] } };
    for (const rows of [[], [{ mt: 1, st: 2 }, { mt: 3, st: 4 }]]) {
      assert.throws(() => dashboard.apply(SESSION_A, {
        action: "upsert", baseRevision: 1, data: { columns: ["mt", "st"], rows }, dateRange, widget,
      }), /必须恰好包含一行/u);
    }
    const nullable = dashboard.apply(SESSION_B, {
      action: "upsert", baseRevision: dashboard.loadOrPreview(SESSION_B).revision,
      data: { columns: ["mt", "st"], rows: [{ mt: null, st: null }] }, dateRange, widget,
    });
    assert.deepEqual(nullable.dashboard.widgets.at(-1)?.data, [{ mt: null, st: null }]);
  }
  const full = dashboard.apply(SESSION_A, {
    action: "upsert", baseRevision: 1,
    data: chartData(Array.from({ length: MAX_DASHBOARD_ROWS_PER_WIDGET }, () => ({ date: "2026-09-01", mt: 90, st: null }))),
    dateRange, widget: lineRequest(),
  });
  assert.equal(full.pointCount, MAX_DASHBOARD_ROWS_PER_WIDGET);
});

test("tool rejects legacy snapshot parameters and malformed data without publishing updates", async (t) => {
  const { dashboard, artifacts } = fixture(t);
  const update = createDashboardTools(dashboard, SESSION_A)[1];
  const arguments_ = {
    action: "upsert", dashboard_id: "default", base_revision: 0,
    date_range: { start: null, end: null },
    widget: { ...lineRequest(), metric_definition: lineRequest().metricDefinition },
  };
  assert.equal("snapshot" in update.parameters.properties, false);
  assert.ok("data" in update.parameters.properties);
  const updates: unknown[] = [];
  const cases: readonly [object, RegExp][] = [
    [{ snapshot: "old-snapshot" }, /已移除 snapshot.*data/u],
    [{}, /缺少参数 data/u],
    [{ data: "{" }, /data 必须是.*合法的 JSON/u],
    [{ data: { columns: ["mt", "mt"], rows: [] } }, /columns/u],
    [{ data: { columns: ["mt"], rows: [{ mt: true }] } }, /mt/u],
    [{ data: '{"columns":["mt"],"rows":[{"mt":1e400}]}' }, /mt/u],
  ];
  for (const [invalid, expected] of cases) {
    await assert.rejects(() => update.execute("invalid", { ...arguments_, ...invalid } as never,
      undefined, (event) => updates.push(event), undefined as never), expected);
    assert.equal(dashboard.loadOrPreview(SESSION_A).revision, 0);
  }
  assert.deepEqual(updates, []);
  assert.equal(existsSync(path.join(artifacts.rootDir, SESSION_A, "dashboard.json")), false);
});

test("empty templates retain the thirteen-card layout and isolate each snapshot", () => {
  const now = new Date("2026-09-22T01:00:00.000Z");
  const state = createDefaultDashboard(now);
  assert.equal(state.dataAsOf, now.toISOString());
  assert.deepEqual(state.dateRange, { start: null, end: null });
  assert.deepEqual(state.widgets.map((widget) => widget.id), DEFAULT_WIDGET_IDS);
  assert.deepEqual(state.widgets.map((widget) => widget.size), [
    "medium", "medium", "medium", "medium", "wide", "wide", "wide", "medium", "wide", "medium", "medium", "medium", "medium",
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
  assert.equal(edited.widgets.length, 12);
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

test("the thirteen-card default allows additions up to twenty-card tool reordering, but rejects a twenty-first", async (t) => {
  const { dashboard } = fixture(t);
  const data = chartData([{ date: "2026-09-01", mt: 90, st: 80 }]);
  const dateRange = { start: "2026-09-01", end: "2026-09-01" };
  const extras = ["extra-a", "extra-b", "extra-c", "extra-d", "extra-e", "extra-f", "extra-g"];
  for (const [index, id] of extras.entries()) {
    const result = dashboard.apply(SESSION_A, { action: "upsert", baseRevision: index, data, dateRange, widget: lineRequest(id) });
    assert.equal(result.dashboard.widgets.length, 13 + index + 1);
  }
  const update = createDashboardTools(dashboard, SESSION_A).find((tool) => tool.name === "update_dashboard")!;
  const widgetIds = dashboard.loadOrInitialize(SESSION_A).widgets.map((widget) => widget.id).reverse();
  const arguments_ = { action: "reorder", dashboard_id: "default", base_revision: extras.length, widget_ids: widgetIds };
  assert.equal(Value.Check(update.parameters, arguments_), true);
  assert.equal(Value.Check(update.parameters, { ...arguments_, widget_ids: [...widgetIds, "extra-h"] }), false);
  await update.execute("reorder-twenty", arguments_ as never, undefined, undefined, undefined as never);
  assert.deepEqual(dashboard.loadOrInitialize(SESSION_A).widgets.map((widget) => widget.id), widgetIds);
  assert.throws(() => dashboard.apply(SESSION_A, {
    action: "upsert", baseRevision: extras.length + 1, data, dateRange, widget: lineRequest("extra-h"),
  }), /最多包含 20 个组件/u);
  assert.equal(dashboard.loadOrInitialize(SESSION_A).revision, extras.length + 1);
  // Updating an existing card at capacity still works.
  assert.equal(dashboard.apply(SESSION_A, {
    action: "upsert", baseRevision: extras.length + 1, data, dateRange, widget: lineRequest("extra-a"),
  }).dashboard.widgets.length, 20);
});
