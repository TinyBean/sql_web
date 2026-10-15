/// <reference lib="dom" />

import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { parseHTML } from "linkedom";
import type { DashboardState, DashboardWidget } from "../../src/shared/dashboard.ts";

interface ChartAxis {
  readonly axisLabel: { readonly formatter: (value: number) => string };
}
interface ChartOption {
  readonly tooltip: { readonly formatter: (params: unknown) => string };
  readonly xAxis: ChartAxis;
  readonly yAxis: ChartAxis;
  readonly series: readonly {
    readonly data: readonly (number | { readonly value: number })[];
    readonly label: { readonly formatter: (params: { readonly name?: string; readonly value: number | null }) => string };
    readonly detail: { readonly formatter: string | ((value: number) => string) };
  }[];
}

test("dashboard displays round consistently across widgets without rounding data or identifiers", async (t) => {
  const browser = parseHTML("<html><body><main id='grid'></main></body></html>");
  const originals = new Map<string, PropertyDescriptor | undefined>();
  for (const name of ["window", "document", "HTMLElement", "HTMLButtonElement"] as const) {
    originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, value: name === "window" ? browser : browser[name] });
  }
  t.after(() => {
    for (const [name, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
  });
  browser.getComputedStyle = () => ({}) as CSSStyleDeclaration;
  const options = new Map<string, ChartOption>();
  Object.defineProperty(browser, "echarts", { value: {
    init(element: HTMLElement) {
      const id = element.closest<HTMLElement>("article")!.dataset["widgetId"]!;
      return { setOption(option: Record<string, unknown>) { options.set(id, option as unknown as ChartOption); }, resize() {}, dispose() {} };
    },
  } });

  const common = { title: "计算结果", subtitle: "2026-09-08", size: "small" as const,
    format: { unit: "%", precision: 0 }, metricDefinition: "保留原始精度", warnings: [] };
  const widgets: DashboardWidget[] = [
    { ...common, id: "kpi", kind: "kpi", data: [{ value: 1.005, comparison: 1.2 }],
      encoding: { value: "value", comparison: "comparison" } },
    { ...common, id: "overview", kind: "overview", data: [{ value: 1.005, gauge: 1.005, missing: null }],
      encoding: { value: "value", gauges: [{ name: "有效值", column: "gauge" }, { name: "缺失值", column: "missing" }] } },
    { ...common, id: "table", kind: "table",
      data: [1.005, 1.2, 1.999, -1.005, -0.004, 12, null].map((value) => ({ value, date: "2026-09-08", machine: "ADH001", text: "1.005" })),
      encoding: { columns: [{ key: "value", label: "数值" }, { key: "date", label: "日期" },
        { key: "machine", label: "机台" }, { key: "text", label: "原始字符串" }] } },
    { ...common, id: "donut", kind: "donut", data: [{ category: "A", value: 1.005 }],
      encoding: { category: "category", value: "value" } },
    ...(["line", "bar", "stacked-bar"] as const).map((kind): DashboardWidget => {
      const data = [{ category: "2026-09-08", value: 1.005 }];
      const encoding = { category: "category", series: [{ name: "OEE", column: "value" }] };
      return kind === "line" ? { ...common, id: kind, kind, data, encoding } :
        { ...common, id: kind, kind, data, encoding: { ...encoding, orientation: "horizontal" } };
    }),
  ];
  const state: DashboardState = { schemaVersion: 1, revision: 0, dataAsOf: "2026-09-08T00:00:00Z",
    dateRange: { start: "2026-09-08", end: "2026-09-08" }, widgets };
  const original = structuredClone(state);
  const moduleUrl = pathToFileURL(path.join(process.cwd(), "src/client/dashboard.ts")).href;
  const { DashboardRenderer } = await import(moduleUrl);
  const grid = browser.document.querySelector("#grid") as unknown as HTMLElement;
  const renderer = new DashboardRenderer(grid);
  t.after(() => renderer.dispose());
  renderer.render(state);

  assert.equal(grid.querySelector(".kpi-content strong")?.textContent, "1.01%");
  assert.equal(grid.querySelector(".kpi-content span")?.textContent, "对比 1.20%");
  assert.equal(grid.querySelector(".overview-oee strong")?.textContent, "1.01%");
  const rows = [...grid.querySelectorAll("tbody tr")].map((row) => [...row.querySelectorAll("td")].map((cell) => cell.textContent));
  assert.deepEqual(rows.map((row) => row[0]), ["1.01", "1.20", "2.00", "-1.01", "0.00", "12", "—"]);
  assert.ok(rows.every((row) => row[1] === "2026-09-08" && row[2] === "ADH001" && row[3] === "1.005"));
  const gauges = options.get("overview")!.series;
  const formatGauge = gauges[0]!.detail.formatter;
  assert.ok(typeof formatGauge === "function");
  assert.equal(formatGauge(1.005), "1.01%");
  assert.equal(formatGauge(12), "12%");
  assert.equal(gauges[1]!.detail.formatter, "—");
  assert.deepEqual(gauges[0]!.data[0], { value: 1.005, name: "有效值" });
  for (const kind of ["line", "bar", "stacked-bar", "donut"]) {
    const option = options.get(kind)!;
    assert.equal(option.tooltip.formatter({ axisValueLabel: "2026-09-08", seriesName: "OEE", value: 1.005 }), "2026-09-08\nOEE  1.01%");
    const series = option.series[0]!;
    if (kind === "donut") {
      assert.equal(series.label.formatter({ name: "A", value: 1.005 }), "A\n1.01%");
      assert.deepEqual(series.data[0], { value: 1.005, name: "A" });
    } else {
      const valueAxis = option[kind === "line" ? "yAxis" : "xAxis"];
      assert.equal(valueAxis.axisLabel.formatter(1.005), "1.01%");
      assert.equal(valueAxis.axisLabel.formatter(12), "12%");
      assert.equal(series.label.formatter({ value: 1.005 }), "1.01%");
      assert.equal(series.label.formatter({ value: null }), "—");
      assert.deepEqual(series.data, [1.005]);
    }
  }
  assert.deepEqual(state, original, "display formatting must not mutate data or legacy precision");
});
