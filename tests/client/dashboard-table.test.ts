/// <reference lib="dom" />

import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { parseHTML } from "linkedom";
import type { DashboardState, DashboardTableWidget } from "../../src/shared/dashboard.ts";
import { createDefaultDashboard } from "../../src/server/dashboard/default/template.ts";

function table(id: string, size: DashboardTableWidget["size"], columnCount = 2): DashboardTableWidget {
  return {
    id, size, kind: "table", title: "完整明细", subtitle: "自适应布局",
    encoding: { columns: Array.from({ length: columnCount }, (_, index) => ({
      key: `c${index}`, label: `列 ${index + 1}`,
    })) },
    data: [{ c0: "MT", c1: 42 }],
    format: { unit: "", precision: 0 }, metricDefinition: "保留全部数据和说明", warnings: [],
  };
}

test("table layout expands by content, reuses measurements, and preserves saved sizes and rows", async (t) => {
  const browser = parseHTML("<html><body><main id='grid'></main></body></html>");
  const originals = new Map<string, PropertyDescriptor | undefined>();
  const expose = (name: string, value: unknown): void => {
    originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  };
  expose("window", browser);
  expose("document", browser.document);
  expose("HTMLElement", browser.HTMLElement);
  expose("HTMLButtonElement", browser.HTMLButtonElement);
  browser.matchMedia = () => ({ matches: false }) as MediaQueryList;
  let frameId = 0;
  const frames = new Map<number, FrameRequestCallback>();
  browser.requestAnimationFrame = (callback) => {
    frames.set(++frameId, callback);
    return frameId;
  };
  browser.cancelAnimationFrame = (id) => { frames.delete(id); };
  const flushFrames = (): void => {
    const pending = [...frames.values()];
    frames.clear();
    for (const callback of pending) callback(0);
  };
  let measured = 0;
  const originalContext = Object.getOwnPropertyDescriptor(browser.HTMLCanvasElement.prototype, "getContext");
  Object.defineProperty(browser.HTMLCanvasElement.prototype, "getContext", {
    configurable: true,
    value: () => ({
      font: "",
      measureText(text: string) {
        measured += 1;
        return { width: [...text].reduce((width, char) => width + (/[^\x00-\x7f]/u.test(char) ? 11 : 7), 0) };
      },
    }),
  });
  let styleReads = 0;
  browser.getComputedStyle = (element: Element) => {
    styleReads += 1;
    const card = element.classList.contains("metric-card");
    const cell = element.tagName === "TH" || element.tagName === "TD";
    return {
      fontStyle: "normal", fontWeight: element.tagName === "TH" ? "700" : "400",
      fontSize: "11px", fontFamily: "sans-serif", columnGap: "15px",
      paddingLeft: card ? "18px" : cell ? "10px" : "0px",
      paddingRight: card ? "18px" : cell ? "10px" : "0px",
      borderLeftWidth: card ? "1px" : "0px", borderRightWidth: card ? "1px" : "0px",
    } as CSSStyleDeclaration;
  };
  const observed = new Set<Element>();
  let resizeCallback: ResizeObserverCallback | undefined;
  expose("ResizeObserver", class {
    constructor(callback: ResizeObserverCallback) { resizeCallback = callback; }
    observe(target: Element): void { observed.add(target); }
    unobserve(target: Element): void { observed.delete(target); }
    disconnect(): void { observed.clear(); }
  });
  t.after(() => {
    if (originalContext) Object.defineProperty(browser.HTMLCanvasElement.prototype, "getContext", originalContext);
    else Reflect.deleteProperty(browser.HTMLCanvasElement.prototype, "getContext");
    for (const [name, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
  });

  const grid = browser.document.querySelector("#grid") as unknown as HTMLElement;
  let width = 1200;
  Object.defineProperty(grid, "getBoundingClientRect", {
    value: () => ({ width }),
  });
  const notifyResize = (flush = true): void => {
    resizeCallback?.(
      [{ target: grid, contentRect: grid.getBoundingClientRect(),
        borderBoxSize: [], contentBoxSize: [], devicePixelContentBoxSize: [] }], {} as ResizeObserver,
    );
    if (flush) flushFrames();
  };
  const moduleUrl = pathToFileURL(path.join(process.cwd(), "src/client/dashboard.ts")).href;
  const { DashboardRenderer } = await import(moduleUrl);
  const renderer = new DashboardRenderer(grid);
  t.after(() => renderer.dispose());
  const simple = table("simple", "small");
  const numeric = table("numeric", "medium", 8);
  const wide = table("wide", "wide");
  let state: DashboardState = {
    schemaVersion: 1, revision: 1, dataAsOf: "2026-09-15T00:00:00Z",
    dateRange: { start: "2026-09-01", end: "2026-09-15" },
    widgets: [simple, numeric, wide],
  };
  const card = (id: string): HTMLElement => grid.querySelector(`[data-widget-id='${id}']`) as HTMLElement;
  renderer.render(state);
  assert.ok(observed.has(grid), "the container must be observed even for a table-only dashboard");
  assert.equal(card("simple").style.gridColumn, "span 3");
  assert.equal(card("numeric").style.gridColumn, "span 12");
  assert.equal(card("wide").style.gridColumn, "span 12");
  assert.equal(numeric.size, "medium", "effective width must not mutate the dashboard snapshot");
  assert.equal(card("numeric").querySelectorAll("col").length, 8);

  const measurements = measured;
  const originalNumeric = card("numeric");
  renderer.render(state);
  assert.equal(card("numeric"), originalNumeric);
  width = 1880;
  notifyResize(false);
  notifyResize(false);
  assert.equal(frames.size, 1, "resize notifications must share one deferred layout frame");
  assert.equal(card("numeric").style.gridColumn, "span 12", "observer delivery must not write layout synchronously");
  flushFrames();
  assert.equal(card("numeric").style.gridColumn, "span 6", "more room should restore the saved size");
  assert.equal(card("wide").style.gridColumn, "span 12", "explicit wide cards must stay wide");
  assert.equal(measured, measurements, "unchanged data must reuse column measurements on render and resize");
  const reads = styleReads;
  notifyResize();
  assert.equal(styleReads, reads, "height-only changes must not recalculate table layouts");
  width = 1371;
  notifyResize();
  assert.equal(card("numeric").style.gridColumn, "span 6", "exact fit includes gaps, padding and borders");
  width = 1370.5;
  notifyResize();
  assert.equal(card("numeric").style.gridColumn, "span 12", "fractional widths below the threshold must expand");

  const longText = "连续中文改善措施".repeat(40);
  const expanded: DashboardTableWidget = {
    ...simple,
    data: [{ c0: longText, c1: "https://example.com/" + "a".repeat(400) }],
  };
  state = { ...state, widgets: [expanded, numeric, wide] };
  renderer.render(state);
  assert.equal(card("simple").style.gridColumn, "span 12", "updated content must invalidate the old widths");
  assert.equal(card("simple").querySelector("td")?.textContent, longText);
  state = { ...state, widgets: [simple, numeric, wide] };
  renderer.render(state);
  assert.equal(card("simple").style.gridColumn, "span 3", "shorter replacement data should restore small");

  const tall: DashboardTableWidget = {
    ...table("tall", "small"),
    data: Array.from({ length: 2000 }, (_, i) => ({ c0: "MT", c1: i === 1999 ? longText : "多行\n短文" })),
  };
  const empty: DashboardTableWidget = {
    ...table("empty", "small", 8), data: [],
  };
  state = { ...state, widgets: [tall, empty, numeric] };
  renderer.render(state, { hiddenWidgetIds: new Set(["numeric"]) });
  assert.equal(card("tall").querySelectorAll("tbody tr").length, 2000);
  assert.equal(card("tall").querySelector("tbody tr:last-child td:last-child")?.textContent, longText);
  assert.equal(card("tall").querySelector("tbody tr:first-child td:last-child")?.textContent, "多行\n短文");
  assert.equal(card("tall").style.gridColumn, "span 6", "long content in the last row must influence width");
  const columns = [...card("tall").querySelectorAll("col")];
  assert.ok(Number.parseFloat(columns[1]!.style.width) > Number.parseFloat(columns[0]!.style.width),
    "long text columns must receive more room than short values");
  assert.equal(card("empty").style.gridColumn, "span 12", "empty tables should size from their headers");
  assert.equal(card("empty").querySelectorAll("tbody tr").length, 0);
  width = 1880;
  notifyResize();
  renderer.render(state);
  assert.equal(card("numeric").style.gridColumn, "span 6", "restoring a hidden table must use the latest width");
  renderer.previewOrder(["numeric", "tall", "empty"]);
  assert.equal(grid.firstElementChild, card("numeric"));
  assert.equal(card("tall").querySelectorAll("tbody tr").length, 2000);

  const defaults = createDefaultDashboard();
  const machineTable = defaults.widgets[5]!;
  assert.equal(machineTable.kind, "table");
  state = { ...defaults, widgets: [machineTable] };
  renderer.render(state);
  const machineCard = card(machineTable.id);
  assert.equal(machineCard.style.gridColumn, "span 12");
  assert.deepEqual([...machineCard.querySelectorAll("th")].map((cell) => cell.textContent), [
    "粒度", "极值", "周期", "周期OEE%", "TOP10 机台（机台 OEE 最低）",
  ]);
  assert.equal(machineCard.querySelectorAll("tbody tr").length, 6);
  const lists = [...machineCard.querySelectorAll("tbody tr td:last-child")];
  assert.deepEqual(lists.map((cell) => cell.textContent), machineTable.data.map((row) => row["top10_machines"]));
  assert.ok(lists.every((cell) => cell.textContent!.includes("10.")));
  const machineColumns = [...machineCard.querySelectorAll("col")];
  assert.ok(Number.parseFloat(machineColumns[4]!.style.width) > Number.parseFloat(machineColumns[0]!.style.width));
  width = 420;
  notifyResize();
  assert.equal(machineCard.style.gridColumn, "span 12");
  assert.deepEqual([...machineCard.querySelectorAll("tbody tr td:last-child")].map((cell) => cell.textContent),
    machineTable.data.map((row) => row["top10_machines"]), "narrow layouts must retain every machine in all six lists");

  width = 1200;
  notifyResize(false);
  assert.equal(frames.size, 1);
  renderer.dispose();
  assert.equal(frames.size, 0, "dispose must cancel a pending layout frame");
  assert.equal(observed.size, 0, "dispose must disconnect the container observer");
  assert.equal(grid.children.length, 0);
  notifyResize();
  assert.equal(grid.children.length, 0, "a queued observer callback must not revive disposed tables");
});
