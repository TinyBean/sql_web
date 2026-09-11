/// <reference lib="dom" />

import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { parseHTML } from "linkedom";
import type { DashboardState } from "../../src/shared/dashboard.ts";

function dashboard(value: number): DashboardState {
  return {
    schemaVersion: 1,
    revision: value,
    dataAsOf: "2026-09-08T00:00:00.000Z",
    dateRange: { start: "2026-09-08", end: "2026-09-08" },
    widgets: [{
      id: "trend",
      kind: "line",
      title: "趋势",
      subtitle: "测试",
      size: "wide",
      data: [{ day: "2026-09-08", value }],
      encoding: { category: "day", series: [{ name: "OEE", column: "value" }] },
      format: { unit: "%", precision: 1 },
      metricDefinition: "受控口径",
      warnings: [],
    }],
  };
}

test("reuses, replaces, resizes, and disposes ECharts instances by widget", async (t) => {
  const browser = parseHTML(
    "<html><body><main id='grid'><article class='dashboard-loading'>加载中</article></main></body></html>",
  );
  const originals = new Map<string, PropertyDescriptor | undefined>();
  const expose = (name: string, value: unknown): void => {
    originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  };
  expose("window", browser);
  expose("document", browser.document);
  expose("HTMLElement", browser.HTMLElement);
  const observed = new Set<Element>();
  let resizeCallback: ResizeObserverCallback | undefined;
  class FakeResizeObserver {
    constructor(callback: ResizeObserverCallback) { resizeCallback = callback; }
    observe(target: Element): void { observed.add(target); }
    unobserve(target: Element): void { observed.delete(target); }
    disconnect(): void { observed.clear(); }
  }
  expose("ResizeObserver", FakeResizeObserver);
  browser.matchMedia = () => ({ matches: false }) as MediaQueryList;

  let initialized = 0;
  let disposed = 0;
  let resized = 0;
  let chartOption: Record<string, unknown> | undefined;
  Object.defineProperty(browser, "echarts", {
    configurable: true,
    value: {
      init() {
        initialized += 1;
        return {
          setOption(option: Record<string, unknown>) { chartOption = option; },
          resize() { resized += 1; },
          dispose() { disposed += 1; },
        };
      },
    },
  });
  t.after(() => {
    for (const [name, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
  });

  const moduleUrl = pathToFileURL(path.join(process.cwd(), "src", "client", "dashboard.ts")).href;
  const { DashboardRenderer } = await import(moduleUrl);
  const grid = browser.document.querySelector("#grid") as unknown as HTMLElement;
  const renderer = new DashboardRenderer(grid);
  renderer.render(dashboard(1));
  assert.equal(grid.querySelector(".dashboard-loading"), null);
  assert.equal(initialized, 1);
  assert.equal(grid.querySelector("[data-widget-id='trend']")?.getAttribute("tabindex"), "0");
  const tooltip = chartOption?.["tooltip"] as Record<string, unknown>;
  assert.equal(tooltip["renderMode"], "richText");
  const formatTooltip = tooltip["formatter"] as (params: unknown) => string;
  assert.equal(formatTooltip([
    { axisValueLabel: "2026-09-08", seriesName: "OEE", value: 1 },
  ]), "2026-09-08\nOEE  1.0%");
  renderer.render(dashboard(1), new Set(["trend"]));
  assert.equal(initialized, 1, "unchanged widget should reuse its chart");
  assert.equal(grid.querySelector("[data-widget-id='trend']")?.classList.contains("pending"), true);
  resizeCallback?.(
    [...observed].map((target) => ({ target } as ResizeObserverEntry)),
    {} as ResizeObserver,
  );
  assert.ok(resized > 0);

  renderer.render(dashboard(2));
  assert.equal(initialized, 2);
  assert.equal(disposed, 1);
  renderer.render({
    ...dashboard(2),
    widgets: [{
      id: "overall-oee-overview",
      kind: "overview",
      title: "Overall OEE",
      subtitle: "最近 7 个业务日",
      size: "wide",
      data: [{ overall: 42.5, availability: 80, dut_on: 75, test_time: 95, yield: 90 }],
      encoding: {
        value: "overall",
        label: "上月综合效率",
        description: "按有效工作日等权平均",
        gauges: [
          { name: "Availability", column: "availability" },
          { name: "DUT-On", column: "dut_on" },
          { name: "Test Time", column: "test_time" },
          { name: "Yield", column: "yield" },
        ],
      },
      format: { unit: "%", precision: 2 },
      metricDefinition: "四个乘数",
      warnings: [],
    }],
  });
  assert.equal(initialized, 3);
  assert.equal(disposed, 2);
  assert.equal(grid.querySelector(".overview-oee span")?.textContent, "上月综合效率");
  assert.equal(grid.querySelector(".overview-oee strong")?.textContent, "42.50%");
  assert.equal(grid.querySelector(".overview-oee small")?.textContent, "按有效工作日等权平均");
  const gaugeSeries = chartOption?.["series"] as Array<Record<string, unknown>>;
  assert.equal(gaugeSeries.length, 4);
  assert.equal(gaugeSeries.every((series) => series["type"] === "gauge"), true);
  renderer.render({ ...dashboard(2), widgets: [] });
  assert.equal(disposed, 3);
  renderer.dispose();
  assert.equal(grid.children.length, 0);
});
