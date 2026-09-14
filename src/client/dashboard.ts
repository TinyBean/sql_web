import type {
  DashboardBarWidget,
  DashboardDonutWidget,
  DashboardLineWidget,
  DashboardOverviewWidget,
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

interface DashboardRenderState {
  readonly pendingWidgetIds?: ReadonlySet<string>;
  readonly hiddenWidgetIds?: ReadonlySet<string>;
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

function overviewOption(widget: DashboardOverviewWidget): Record<string, unknown> {
  const row = widget.data[0];
  const gauges = widget.encoding.gauges;
  return {
    ...commonChartOption(widget),
    tooltip: { show: false },
    series: gauges.map((gauge, index) => {
      const value = numeric(row?.[gauge.column]);
      const maximum = value === null || value <= 100 ? 100 : Math.ceil(value / 10) * 10;
      const minimum = value === null || value >= 0 ? 0 : Math.floor(value / 10) * 10;
      return {
        name: gauge.name,
        type: "gauge",
        center: [`${((index + 0.5) / gauges.length) * 100}%`, "51%"],
        radius: "72%",
        min: minimum,
        max: maximum,
        startAngle: 210,
        endAngle: -30,
        splitNumber: 5,
        progress: {
          show: value !== null,
          roundCap: true,
          width: 8,
          itemStyle: { color: COLORS[index % COLORS.length] },
        },
        pointer: {
          show: value !== null,
          length: "52%",
          width: 3,
          itemStyle: { color: COLORS[index % COLORS.length] },
        },
        anchor: {
          show: value !== null,
          size: 7,
          itemStyle: { color: COLORS[index % COLORS.length], borderColor: "#09120f", borderWidth: 2 },
        },
        axisLine: { lineStyle: { width: 8, color: [[1, "#263a33"]] } },
        axisTick: { show: false },
        splitLine: { distance: -11, length: 5, lineStyle: { color: "#61776d", width: 1 } },
        axisLabel: { show: false },
        title: {
          offsetCenter: [0, "76%"],
          color: "#a6b6af",
          fontSize: 12,
          fontWeight: 600,
        },
        detail: {
          offsetCenter: [0, "38%"],
          color: value === null ? "#71847b" : "#f2fbf6",
          fontSize: 17,
          fontWeight: 650,
          formatter: value === null
            ? "—"
            : (displayValue: number) => `${displayValue.toFixed(1)}${widget.format.unit}`,
        },
        data: [{ value: value ?? 0, name: gauge.name }],
      };
    }),
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
  kind.textContent = widget.kind === "kpi"
    ? "KPI"
    : widget.kind === "overview" ? "OVERVIEW" : widget.kind.toUpperCase();
  const controls = document.createElement("div");
  controls.className = "metric-card-controls";
  controls.append(
    createCardButton(
      "metric-drag-handle",
      `拖动“${widget.title}”调整顺序`,
      "dragHandle",
      widget.id,
      "M9 5h.01M15 5h.01M9 12h.01M15 12h.01M9 19h.01M15 19h.01",
    ),
    createCardButton(
      "metric-close-button",
      `关闭“${widget.title}”`,
      "closeWidgetId",
      widget.id,
      "m7 7 10 10M17 7 7 17",
    ),
  );
  const trailing = document.createElement("div");
  trailing.className = "metric-card-trailing";
  trailing.append(kind, controls);
  header.append(copy, trailing);
  return header;
}

function createCardButton(
  className: string,
  label: string,
  dataName: "dragHandle" | "closeWidgetId",
  widgetId: string,
  pathData: string,
): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = className;
  button.setAttribute("aria-label", label);
  button.title = label;
  button.dataset[dataName] = widgetId;
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("d", pathData);
  svg.append(path);
  button.append(svg);
  return button;
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
  } else if (widget.kind === "overview") {
    const content = document.createElement("div");
    content.className = "overview-content";
    const overall = document.createElement("div");
    overall.className = "overview-oee";
    const label = document.createElement("span");
    label.textContent = widget.encoding.label ?? widget.title;
    const number = document.createElement("strong");
    const value = widget.data[0]?.[widget.encoding.value];
    number.textContent = formatted(value, widget.format.unit, widget.format.precision);
    number.classList.toggle("unavailable", numeric(value) === null);
    const formula = document.createElement("small");
    formula.textContent = widget.encoding.description ?? widget.metricDefinition;
    overall.append(label, number, formula);

    chartHost = document.createElement("div");
    chartHost.className = "chart-host overview-gauges";
    chartHost.setAttribute("role", "img");
    chartHost.setAttribute(
      "aria-label",
      `${widget.title}：${widget.encoding.gauges.map((gauge) => gauge.name).join("、")} 仪表盘`,
    );
    content.append(overall, chartHost);
    card.append(content);
    const api = window.echarts;
    if (!api) throw new Error("ECharts 未加载");
    chart = api.init(chartHost, null, { renderer: "canvas" });
    chart.setOption(overviewOption(widget), { notMerge: true });
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
  readonly #positionAnimations = new Map<string, Animation>();
  #editing = false;
  #saving = false;

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

  render(dashboard: DashboardState, state: DashboardRenderState = {}): void {
    const pendingWidgetIds = state.pendingWidgetIds ?? new Set<string>();
    const hiddenWidgetIds = state.hiddenWidgetIds ?? new Set<string>();
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
      rendered.element.hidden = hiddenWidgetIds.has(widget.id);
      this.#container.append(rendered.element);
      rendered.chart?.resize();
    }
    this.#renderEmptyState(dashboard.widgets.every((widget) => hiddenWidgetIds.has(widget.id)));
    this.#syncControls();
  }

  setEditing(editing: boolean, saving = false): void {
    this.#editing = editing;
    this.#saving = saving;
    this.#container.classList.toggle("dashboard-editing", editing);
    this.#container.classList.toggle("dashboard-saving", saving);
    this.#syncControls();
  }

  previewOrder(widgetIds: readonly string[]): void {
    const positions = new Map<string, DOMRect>();
    for (const [id, rendered] of this.#widgets) {
      if (!rendered.element.hidden && rendered.element.isConnected) {
        positions.set(id, rendered.element.getBoundingClientRect());
      }
    }
    for (const animation of this.#positionAnimations.values()) animation.cancel();
    this.#positionAnimations.clear();
    const requested = new Set(widgetIds);
    for (const id of widgetIds) {
      const rendered = this.#widgets.get(id);
      if (rendered) this.#container.append(rendered.element);
    }
    for (const [id, rendered] of this.#widgets) {
      if (!requested.has(id)) this.#container.append(rendered.element);
    }
    const empty = this.#container.querySelector(".dashboard-empty");
    if (empty) this.#container.append(empty);
    if (reducedMotion) return;
    for (const [id, rendered] of this.#widgets) {
      const previous = positions.get(id);
      if (!previous || rendered.element.hidden) continue;
      const next = rendered.element.getBoundingClientRect();
      const x = previous.left - next.left;
      const y = previous.top - next.top;
      if (
        (Math.abs(x) < 1 && Math.abs(y) < 1) ||
        typeof rendered.element.animate !== "function"
      ) continue;
      const animation = rendered.element.animate([
        { transform: `translate(${x}px, ${y}px)` },
        { transform: "translate(0, 0)" },
      ], {
        duration: 220,
        easing: "cubic-bezier(.2, .75, .25, 1)",
      });
      this.#positionAnimations.set(id, animation);
      animation.addEventListener("finish", () => {
        if (this.#positionAnimations.get(id) === animation) {
          this.#positionAnimations.delete(id);
        }
      }, { once: true });
    }
  }

  settleWidget(widgetId: string): void {
    if (reducedMotion) return;
    const rendered = this.#widgets.get(widgetId);
    if (!rendered || typeof rendered.element.animate !== "function") return;
    this.#positionAnimations.get(widgetId)?.cancel();
    this.#positionAnimations.delete(widgetId);
    rendered.element.animate([
      { transform: "scale(.985)", filter: "brightness(1.1)" },
      { transform: "scale(1)", filter: "brightness(1)" },
    ], {
      duration: 180,
      easing: "cubic-bezier(.2, .75, .25, 1)",
    });
  }

  dispose(): void {
    for (const animation of this.#positionAnimations.values()) animation.cancel();
    this.#positionAnimations.clear();
    for (const rendered of this.#widgets.values()) this.#disposeWidget(rendered);
    this.#widgets.clear();
    this.#resizeObserver.disconnect();
    this.#container.replaceChildren();
  }

  #disposeWidget(rendered: RenderedWidget): void {
    const widgetId = rendered.element.dataset["widgetId"];
    if (widgetId) {
      this.#positionAnimations.get(widgetId)?.cancel();
      this.#positionAnimations.delete(widgetId);
    }
    if (rendered.chartHost) this.#resizeObserver.unobserve(rendered.chartHost);
    rendered.chart?.dispose();
    rendered.element.remove();
  }

  #renderEmptyState(empty: boolean): void {
    const current = this.#container.querySelector(".dashboard-empty");
    if (!empty) {
      current?.remove();
      return;
    }
    if (current) return;
    const placeholder = document.createElement("div");
    placeholder.className = "dashboard-empty";
    const title = document.createElement("strong");
    title.textContent = "当前看板为空";
    const copy = document.createElement("p");
    copy.textContent = "可以通过 Agent 对话重新添加指标图表。";
    placeholder.append(title, copy);
    this.#container.append(placeholder);
  }

  #syncControls(): void {
    for (const control of this.#container.querySelectorAll(
      ".metric-drag-handle, .metric-close-button",
    )) {
      if (!(control instanceof HTMLButtonElement)) continue;
      control.disabled = !this.#editing || this.#saving;
      control.tabIndex = this.#editing ? 0 : -1;
      if (control.classList.contains("metric-drag-handle")) {
        control.draggable = false;
      }
    }
  }
}
