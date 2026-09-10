import type {
  DashboardBarWidget,
  DashboardDonutWidget,
  DashboardLineWidget,
  DashboardState,
  DashboardWidget,
} from "../shared/dashboard.ts";

interface EChartsInstance {
  setOption(option: Record<string, unknown>, options?: { readonly notMerge?: boolean }): void;
  resize(): void;
  dispose(): void;
}

interface EChartsApi {
  init(element: HTMLElement, theme?: string | null, options?: { readonly renderer?: "canvas" }): EChartsInstance;
}

declare global {
  interface Window {
    readonly echarts?: EChartsApi;
  }
}

interface RenderedWidget {
  readonly element: HTMLElement;
  readonly fingerprint: string;
  readonly chart: EChartsInstance | null;
  readonly chartHost: HTMLElement | null;
}

interface ResizeObserverLike {
  observe(target: Element): void;
  unobserve(target: Element): void;
  disconnect(): void;
}

const COLORS = ["#47e5b1", "#68a7ff", "#ffbf69", "#a986ff", "#f27c8d", "#6bd5e8"];
const reducedMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;

function scalarText(value: string | number | null | undefined): string {
  return value === null || value === undefined ? "—" : String(value);
}

function numeric(value: string | number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function formatted(value: string | number | null | undefined, unit: string, precision: number): string {
  const number = numeric(value);
  return number === null ? "无法计算" : `${number.toFixed(precision)}${unit}`;
}

function tooltipFormatter(unit: string, precision: number): (params: unknown) => string {
  return (params) => {
    const items = Array.isArray(params) ? params : [params];
    const lines: string[] = [];
    for (const item of items) {
      if (typeof item !== "object" || item === null) continue;
      const source = item as Record<string, unknown>;
      const label = typeof source["seriesName"] === "string" ? source["seriesName"] : "";
      const axis = typeof source["axisValueLabel"] === "string" ? source["axisValueLabel"] : "";
      const raw = Array.isArray(source["value"])
        ? source["value"].at(-1)
        : source["value"];
      const value = typeof raw === "number" ? `${raw.toFixed(precision)}${unit}` : scalarText(raw as string | null);
      if (!lines.length && axis) lines.push(axis);
      lines.push(`${label ? `${label}  ` : ""}${value}`);
    }
    return lines.join("\n");
  };
}

function commonChartOption(widget: DashboardWidget): Record<string, unknown> {
  return {
    animation: !reducedMotion,
    color: COLORS,
    aria: {
      enabled: true,
      description: `${widget.title}。${widget.subtitle}。${widget.metricDefinition}`,
    },
    textStyle: { color: "#a6b6af", fontFamily: "Inter, system-ui, sans-serif" },
    tooltip: {
      trigger: widget.kind === "donut" ? "item" : "axis",
      backgroundColor: "rgba(9, 17, 15, .96)",
      borderColor: "#273a33",
      textStyle: { color: "#eef7f2" },
      renderMode: "richText",
      formatter: tooltipFormatter(widget.format.unit, widget.format.precision),
    },
  };
}

function cartesianOption(widget: DashboardLineWidget | DashboardBarWidget): Record<string, unknown> {
  const categories = widget.data.map((row) => scalarText(row[widget.encoding.category]));
  const horizontal = widget.kind !== "line" && widget.encoding.orientation === "horizontal";
  const categoryAxis = {
    type: "category",
    data: categories,
    axisLabel: { color: "#82968d", hideOverlap: true },
    axisLine: { lineStyle: { color: "#2a3b35" } },
    axisTick: { show: false },
  };
  const valueAxis = {
    type: "value",
    axisLabel: {
      color: "#82968d",
      formatter: `{value}${widget.format.unit}`,
    },
    splitLine: { lineStyle: { color: "rgba(126, 151, 140, .12)" } },
  };
  const series = widget.encoding.series.map((item, index) => ({
    name: item.name,
    type: widget.kind === "line" ? "line" : "bar",
    data: widget.data.map((row) => numeric(row[item.column])),
    connectNulls: false,
    showSymbol: widget.data.length <= 20,
    symbolSize: 6,
    smooth: widget.kind === "line" ? 0.22 : false,
    stack: widget.kind === "stacked-bar" ? "total" : undefined,
    barMaxWidth: 24,
    itemStyle: widget.kind === "line" ? undefined : { borderRadius: horizontal ? [0, 4, 4, 0] : [4, 4, 0, 0] },
    lineStyle: { width: 2 },
    areaStyle: widget.kind === "line" && index === 0 ? { opacity: 0.06 } : undefined,
  }));
  return {
    ...commonChartOption(widget),
    legend: {
      top: 0,
      right: 0,
      textStyle: { color: "#9aacA4" },
      itemWidth: 10,
      itemHeight: 4,
    },
    grid: {
      top: 36,
      right: horizontal ? 28 : 18,
      bottom: 28,
      left: horizontal ? 98 : 48,
      containLabel: false,
    },
    xAxis: horizontal ? valueAxis : categoryAxis,
    yAxis: horizontal ? categoryAxis : valueAxis,
    series,
  };
}

function donutOption(widget: DashboardDonutWidget): Record<string, unknown> {
  return {
    ...commonChartOption(widget),
    legend: { right: 0, orient: "vertical", textStyle: { color: "#9aaca4" } },
    series: [{
      name: widget.title,
      type: "pie",
      radius: ["53%", "78%"],
      center: ["38%", "52%"],
      avoidLabelOverlap: true,
      label: { show: false },
      emphasis: { label: { show: true, color: "#eef7f2", fontWeight: 700 } },
      data: widget.data.map((row) => ({
        name: scalarText(row[widget.encoding.category]),
        value: numeric(row[widget.encoding.value]),
      })),
    }],
  };
}

function createHeader(widget: DashboardWidget): HTMLElement {
  const header = document.createElement("header");
  header.className = "metric-card-header";
  const copy = document.createElement("div");
  const title = document.createElement("h2");
  title.textContent = widget.title;
  const subtitle = document.createElement("p");
  subtitle.textContent = widget.subtitle;
  copy.append(title, subtitle);
  const kind = document.createElement("span");
  kind.className = "metric-kind";
  kind.textContent = widget.kind === "kpi" ? "KPI" : widget.kind.toUpperCase();
  header.append(copy, kind);
  return header;
}

function appendWarnings(card: HTMLElement, widget: DashboardWidget): void {
  if (!widget.warnings.length) return;
  const details = document.createElement("details");
  details.className = "metric-warning";
  const summary = document.createElement("summary");
  summary.textContent = `数据提醒 ${widget.warnings.length}`;
  const list = document.createElement("ul");
  for (const warning of widget.warnings) {
    const item = document.createElement("li");
    item.textContent = warning;
    list.append(item);
  }
  details.append(summary, list);
  card.append(details);
}

function createTable(widget: Extract<DashboardWidget, { readonly kind: "table" }>): HTMLElement {
  const wrapper = document.createElement("div");
  wrapper.className = "metric-table-wrap";
  const table = document.createElement("table");
  const head = document.createElement("thead");
  const headRow = document.createElement("tr");
  for (const column of widget.encoding.columns) {
    const cell = document.createElement("th");
    cell.scope = "col";
    cell.textContent = column.label;
    headRow.append(cell);
  }
  head.append(headRow);
  const body = document.createElement("tbody");
  for (const row of widget.data) {
    const bodyRow = document.createElement("tr");
    for (const column of widget.encoding.columns) {
      const cell = document.createElement("td");
      cell.textContent = scalarText(row[column.key]);
      bodyRow.append(cell);
    }
    body.append(bodyRow);
  }
  table.append(head, body);
  wrapper.append(table);
  return wrapper;
}

function createWidget(widget: DashboardWidget): RenderedWidget {
  const card = document.createElement("article");
  card.className = `metric-card metric-${widget.kind} metric-size-${widget.size}`;
  card.dataset["widgetId"] = widget.id;
  card.tabIndex = 0;
  card.setAttribute("aria-label", `${widget.title}。${widget.subtitle}。${widget.metricDefinition}`);
  card.append(createHeader(widget));

  let chart: EChartsInstance | null = null;
  let chartHost: HTMLElement | null = null;
  if (widget.kind === "kpi") {
    const content = document.createElement("div");
    content.className = "kpi-content";
    const value = widget.data[0]?.[widget.encoding.value];
    const number = document.createElement("strong");
    number.textContent = formatted(value, widget.format.unit, widget.format.precision);
    number.classList.toggle("unavailable", numeric(value) === null);
    content.append(number);
    if (widget.encoding.comparison) {
      const comparison = document.createElement("span");
      comparison.textContent = `对比 ${formatted(widget.data[0]?.[widget.encoding.comparison], widget.format.unit, widget.format.precision)}`;
      content.append(comparison);
    }
    card.append(content);
  } else if (widget.kind === "table") {
    card.append(createTable(widget));
  } else if (!widget.data.length) {
    const empty = document.createElement("div");
    empty.className = "metric-empty";
    empty.textContent = "无法计算";
    card.append(empty);
  } else {
    chartHost = document.createElement("div");
    chartHost.className = "chart-host";
    chartHost.setAttribute("role", "img");
    chartHost.setAttribute("aria-label", `${widget.title} 图表`);
    card.append(chartHost);
    const api = window.echarts;
    if (!api) throw new Error("ECharts 未加载");
    chart = api.init(chartHost, null, { renderer: "canvas" });
    chart.setOption(
      widget.kind === "donut" ? donutOption(widget) : cartesianOption(widget),
      { notMerge: true },
    );
  }
  appendWarnings(card, widget);
  const definition = document.createElement("p");
  definition.className = "metric-definition";
  definition.textContent = widget.metricDefinition;
  card.append(definition);
  return { element: card, fingerprint: JSON.stringify(widget), chart, chartHost };
}

export class DashboardRenderer {
  readonly #container: HTMLElement;
  readonly #widgets = new Map<string, RenderedWidget>();
  readonly #resizeObserver: ResizeObserverLike;

  constructor(container: HTMLElement) {
    this.#container = container;
    this.#resizeObserver = typeof ResizeObserver === "function"
      ? new ResizeObserver((entries) => {
          for (const entry of entries) {
            const widgetId = (entry.target as HTMLElement).dataset["chartFor"];
            if (widgetId) this.#widgets.get(widgetId)?.chart?.resize();
          }
        })
      : { observe: () => {}, unobserve: () => {}, disconnect: () => {} };
  }

  render(dashboard: DashboardState, pendingWidgetIds: ReadonlySet<string> = new Set()): void {
    for (const placeholder of this.#container.querySelectorAll(".dashboard-loading")) {
      placeholder.remove();
    }
    const liveIds = new Set(dashboard.widgets.map((widget) => widget.id));
    for (const [id, rendered] of this.#widgets) {
      if (liveIds.has(id)) continue;
      this.#disposeWidget(rendered);
      this.#widgets.delete(id);
    }

    for (const widget of dashboard.widgets) {
      const fingerprint = JSON.stringify(widget);
      let rendered = this.#widgets.get(widget.id);
      if (!rendered || rendered.fingerprint !== fingerprint) {
        const replacement = createWidget(widget);
        if (rendered) {
          this.#disposeWidget(rendered);
          rendered.element.replaceWith(replacement.element);
        }
        rendered = replacement;
        this.#widgets.set(widget.id, rendered);
        if (rendered.chartHost) {
          rendered.chartHost.dataset["chartFor"] = widget.id;
          this.#resizeObserver.observe(rendered.chartHost);
        }
      }
      rendered.element.classList.toggle("pending", pendingWidgetIds.has(widget.id));
      rendered.element.setAttribute("aria-busy", String(pendingWidgetIds.has(widget.id)));
      this.#container.append(rendered.element);
      rendered.chart?.resize();
    }
  }

  dispose(): void {
    for (const rendered of this.#widgets.values()) this.#disposeWidget(rendered);
    this.#widgets.clear();
    this.#resizeObserver.disconnect();
    this.#container.replaceChildren();
  }

  #disposeWidget(rendered: RenderedWidget): void {
    if (rendered.chartHost) this.#resizeObserver.unobserve(rendered.chartHost);
    rendered.chart?.dispose();
    rendered.element.remove();
  }
}
