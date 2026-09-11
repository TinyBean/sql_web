import assert from "node:assert/strict";
import test from "node:test";
import {
  DashboardValidationError,
  parseDashboardState,
} from "../../src/shared/dashboard.ts";

const common = {
  subtitle: "测试组件",
  size: "medium",
  format: { unit: "%", precision: 1 },
  metricDefinition: "测试口径",
  warnings: [],
} as const;

function allKinds(): unknown {
  return {
    schemaVersion: 1,
    revision: 4,
    dataAsOf: "2026-09-08T12:00:00.000Z",
    dateRange: { start: "2026-09-01", end: "2026-09-08" },
    widgets: [
      { ...common, id: "kpi-one", kind: "kpi", title: "KPI", data: [{ value: 1 }], encoding: { value: "value", comparison: null } },
      { ...common, id: "overview-one", kind: "overview", title: "Overview", data: [{ value: 1, factor: 2 }], encoding: { value: "value", label: "月度综合值", description: "按有效日平均", gauges: [{ name: "Factor", column: "factor" }] } },
      { ...common, id: "line-one", kind: "line", title: "Line", data: [{ day: "1", value: 1 }], encoding: { category: "day", series: [{ name: "A", column: "value" }] } },
      { ...common, id: "bar-one", kind: "bar", title: "Bar", data: [{ name: "A", value: 1 }], encoding: { category: "name", series: [{ name: "A", column: "value" }], orientation: "vertical" } },
      { ...common, id: "stacked-one", kind: "stacked-bar", title: "Stacked", data: [{ name: "A", value: 1 }], encoding: { category: "name", series: [{ name: "A", column: "value" }], orientation: "horizontal" } },
      { ...common, id: "donut-one", kind: "donut", title: "Donut", data: [{ name: "A", value: 1 }], encoding: { category: "name", value: "value" } },
      { ...common, id: "table-one", kind: "table", title: "Table", data: [{ name: "A" }], encoding: { columns: [{ key: "name", label: "名称" }] } },
    ],
  };
}

test("validates every controlled dashboard widget kind", () => {
  const dashboard = parseDashboardState(allKinds());
  assert.deepEqual(dashboard.widgets.map((widget) => widget.kind), [
    "kpi",
    "overview",
    "line",
    "bar",
    "stacked-bar",
    "donut",
    "table",
  ]);
});

test("rejects duplicate widgets and dashboard data limits", () => {
  const base = allKinds() as { widgets: unknown[] };
  assert.throws(
    () => parseDashboardState({ ...base, widgets: [...base.widgets, base.widgets[0]] }),
    DashboardValidationError,
  );
  const line = base.widgets[2] as Record<string, unknown>;
  assert.throws(
    () => parseDashboardState({
      ...base,
      widgets: [{ ...line, data: Array.from({ length: 2_001 }, (_, value) => ({ day: String(value), value })) }],
    }),
    /2000/u,
  );
  assert.throws(
    () => parseDashboardState({
      ...base,
      widgets: [{
        ...line,
        encoding: {
          category: "day",
          series: Array.from({ length: 7 }, (_, index) => ({ name: `S${index}`, column: "value" })),
        },
      }],
    }),
    /6/u,
  );
});
