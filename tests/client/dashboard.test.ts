/// <reference lib="dom" />

import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { parseHTML } from "linkedom";
import type { DashboardState } from "../../src/shared/dashboard.ts";
import { createDefaultDashboard } from "../../src/server/dashboard/default/template.ts";

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
  expose("HTMLButtonElement", browser.HTMLButtonElement);
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
  const chartOptions: Record<string, unknown>[] = [];
  Object.defineProperty(browser, "echarts", {
    configurable: true,
    value: {
      init() {
        initialized += 1;
        return {
          setOption(option: Record<string, unknown>) { chartOption = option; chartOptions.push(option); },
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
  const twoWidgets: DashboardState = {
    ...dashboard(1),
    widgets: [
      ...dashboard(1).widgets,
      {
        id: "secondary",
        kind: "kpi",
        title: "辅助指标",
        subtitle: "测试",
        size: "small",
        data: [{ value: 2 }],
        encoding: { value: "value", comparison: null },
        format: { unit: "%", precision: 1 },
        metricDefinition: "辅助口径",
        warnings: [],
      },
    ],
  };
  renderer.render(twoWidgets);
  let animated = 0;
  const visualOffsets = new Map<HTMLElement, number>();
  const animationFrames: Keyframe[][] = [];
  for (const card of grid.querySelectorAll<HTMLElement>("[data-widget-id]")) {
    Object.defineProperties(card, {
      offsetLeft: { get: () => [...grid.children].indexOf(card) * 100 },
      offsetTop: { get: () => 0 },
      offsetWidth: { get: () => 90 },
      offsetHeight: { get: () => 90 },
    });
    Object.defineProperty(card, "getBoundingClientRect", {
      configurable: true,
      value(): DOMRect {
        const cards = [...grid.querySelectorAll("[data-widget-id]")];
        const left = cards.indexOf(card) * 100 + (visualOffsets.get(card) ?? 0);
        return {
          x: left,
          y: 0,
          left,
          right: left + 90,
          top: 0,
          bottom: 90,
          width: 90,
          height: 90,
          toJSON: () => ({}),
        };
      },
    });
    Object.defineProperty(card, "animate", {
      configurable: true,
      value(frames: Keyframe[]): Animation {
        animated += 1;
        animationFrames.push(frames);
        return {
          cancel() { visualOffsets.delete(card); },
          addEventListener() {},
        } as unknown as Animation;
      },
    });
  }
  renderer.previewOrder(["secondary", "trend"]);
  assert.deepEqual(
    [...grid.querySelectorAll("[data-widget-id]")].map((card) => (card as HTMLElement).dataset["widgetId"]),
    ["secondary", "trend"],
  );
  assert.equal(animated, 2, "both displaced cards should receive FLIP animations");
  renderer.previewOrder(["secondary", "trend"]);
  assert.equal(animated, 2, "the same order must not restart animations");
  const trend = grid.querySelector<HTMLElement>("[data-widget-id='trend']") as HTMLElement;
  const secondary = grid.querySelector<HTMLElement>("[data-widget-id='secondary']") as HTMLElement;
  visualOffsets.set(secondary, 40);
  assert.equal(renderer.readLayout().widgets.get("secondary")?.left, 0,
    "hit testing must ignore the in-flight visual transform");
  assert.equal(secondary.getBoundingClientRect().left, 40);
  trend.classList.add("dragging-source");
  renderer.previewOrder(["trend", "secondary"]);
  assert.equal(animated, 3, "the invisible source must not animate");
  assert.equal(animationFrames.at(-1)?.[0]?.["transform"], "translate(-60px, 0px)",
    "a retargeted animation must start at the current visual position");
  trend.classList.remove("dragging-source");
  assert.equal(initialized, 1, "reordering must retain the original chart");
  renderer.render(dashboard(1));
  renderer.render(dashboard(1), { pendingWidgetIds: new Set(["trend"]) });
  assert.equal(initialized, 1, "unchanged widget should reuse its chart");
  assert.equal(grid.querySelector("[data-widget-id='trend']")?.classList.contains("pending"), true);
  const dragHandle = grid.querySelector("[data-drag-handle='trend']") as HTMLButtonElement;
  const closeButton = grid.querySelector("[data-close-widget-id='trend']") as HTMLButtonElement;
  assert.equal(dragHandle.disabled, true);
  assert.equal(closeButton.getAttribute("aria-label"), "关闭“趋势”");
  renderer.setEditing(true);
  assert.equal(grid.classList.contains("dashboard-editing"), true);
  assert.equal(dragHandle.disabled, false);
  assert.equal(dragHandle.draggable, false, "pointer dragging must not start native HTML drag");
  renderer.setEditing(true, true);
  assert.equal(dragHandle.disabled, true);
  assert.equal(dragHandle.draggable, false);
  renderer.setEditing(false);
  renderer.render(dashboard(1), { hiddenWidgetIds: new Set(["trend"]) });
  assert.equal(grid.querySelector("[data-widget-id='trend']")?.hasAttribute("hidden"), true);
  assert.match(grid.querySelector(".dashboard-empty")?.textContent ?? "", /当前看板为空/u);
  assert.equal(initialized, 1, "hiding a widget must preserve its chart");
  resizeCallback?.(
    [...observed].map((target) => ({ target, contentRect: target.getBoundingClientRect() } as ResizeObserverEntry)),
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
      data: [{ overall: 42.5, availability: 80, performance: 75, yield: 90 }],
      encoding: {
        value: "overall",
        label: "上月综合效率",
        description: "按有效工作日等权平均",
        gauges: [
          { name: "Availability", column: "availability" },
          { name: "Performance", column: "performance" },
          { name: "Yield", column: "yield" },
        ],
      },
      format: { unit: "%", precision: 2 },
      metricDefinition: "三个乘数",
      warnings: [],
    }],
  });
  assert.equal(initialized, 3);
  assert.equal(disposed, 2);
  assert.equal(grid.querySelector(".overview-oee span")?.textContent, "上月综合效率");
  assert.equal(grid.querySelector(".overview-oee strong")?.textContent, "42.50%");
  assert.equal(grid.querySelector(".overview-oee small")?.textContent, "按有效工作日等权平均");
  const gaugeSeries = chartOption?.["series"] as Array<Record<string, unknown>>;
  assert.equal(gaugeSeries.length, 3);
  assert.equal(gaugeSeries.every((series) => series["type"] === "gauge"), true);

  const defaults = createDefaultDashboard();
  renderer.render({ ...defaults, widgets: defaults.widgets.slice(0, 2) });
  assert.equal(initialized, 5);
  assert.equal(disposed, 3);
  assert.deepEqual([...grid.querySelectorAll<HTMLElement>(".metric-overview.metric-size-wide")].map((card) => card.dataset["widgetId"]),
    ["mt-oee-overview", "st-oee-overview"]);
  for (const [index, option] of chartOptions.slice(-2).entries()) {
    const widget = defaults.widgets[index]!;
    const card = grid.querySelector(`[data-widget-id='${widget.id}']`)!;
    assert.equal(card.querySelector(".overview-oee span")?.textContent, "Overall OEE");
    assert.equal(card.querySelector(".overview-oee strong")?.textContent,
      Number(widget.data[0]?.["overall_oee_percent"]).toFixed(2) + "%");
    const series = option["series"] as Array<{ name: string; data: Array<{ value: number }> }>;
    assert.deepEqual(series.map((gauge) => gauge.name), ["Availability", "Performance", "Yield"]);
    assert.deepEqual(series.map((gauge) => gauge.data[0]?.value), [
      widget.data[0]?.["avg_availability_percent"], widget.data[0]?.["avg_performance_percent"], widget.data[0]?.["avg_yield_percent"],
    ]);
  }
  renderer.render({ ...dashboard(2), widgets: [] });
  assert.equal(disposed, 5);
  renderer.dispose();
  assert.equal(grid.children.length, 0);
});
