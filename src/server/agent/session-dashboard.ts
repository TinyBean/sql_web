import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeSync,
} from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  DASHBOARD_SCHEMA_VERSION,
  MAX_DASHBOARD_FILE_BYTES,
  MAX_DASHBOARD_ROWS_PER_WIDGET,
  MAX_DASHBOARD_WIDGETS,
  parseDashboardState,
  type DashboardBarEncoding,
  type DashboardDonutEncoding,
  type DashboardKpiEncoding,
  type DashboardLineEncoding,
  type DashboardOverviewEncoding,
  type DashboardRow,
  type DashboardState,
  type SessionDashboard,
  DASHBOARD_ID_PATTERN,
  type DashboardTableEncoding,
  type DashboardWidget,
  type DashboardWidgetSize,
} from "../../shared/dashboard.ts";
import type { ArtifactStore } from "../tool/artifact-store.ts";
import { formatMachineMentions, machineLabel, formatMachineAnalysisWidget } from "../skills/test-oee-calculator/assets/machine-platforms.ts";

export type InitialDashboardProvider = (sessionId: string) => DashboardState | readonly SessionDashboard[];
export type DashboardIdentity = Pick<SessionDashboard, "id" | "title">;
export type DashboardIdentityProvider = (sessionId: string) => readonly DashboardIdentity[] | undefined;

const DASHBOARD_FILENAME = "dashboard.json";
const SESSION_ID_PATTERN = /^[A-Za-z0-9-]{8,100}$/u;

interface DashboardEntry extends DashboardIdentity {
  readonly baseline: DashboardState;
  readonly current: DashboardState;
}
interface DashboardDocument {
  readonly schemaVersion: 2;
  readonly dashboards: readonly DashboardEntry[];
}

interface WidgetRequestBase {
  readonly id: string;
  readonly title: string;
  readonly subtitle: string;
  readonly size: DashboardWidgetSize;
  readonly format: { readonly unit: string; readonly precision: number };
  readonly metricDefinition: string;
  readonly warnings: readonly string[];
}

export type DashboardWidgetRequest = WidgetRequestBase & (
  | { readonly kind: "kpi"; readonly encoding: DashboardKpiEncoding }
  | { readonly kind: "overview"; readonly encoding: DashboardOverviewEncoding }
  | { readonly kind: "line"; readonly encoding: DashboardLineEncoding }
  | { readonly kind: "bar" | "stacked-bar"; readonly encoding: DashboardBarEncoding }
  | { readonly kind: "donut"; readonly encoding: DashboardDonutEncoding }
  | { readonly kind: "table"; readonly encoding: DashboardTableEncoding }
);

export interface DashboardData {
  readonly columns: readonly string[];
  readonly rows: readonly DashboardRow[];
}

export type DashboardCommand =
  | {
      readonly action: "upsert";
      readonly baseRevision: number;
      readonly data: DashboardData;
      readonly dateRange: { readonly start: string | null; readonly end: string | null };
      readonly widget: DashboardWidgetRequest;
    }
  | { readonly action: "remove"; readonly baseRevision: number; readonly widgetId: string }
  | { readonly action: "reorder"; readonly baseRevision: number; readonly widgetIds: readonly string[] }
  | { readonly action: "reset"; readonly baseRevision: number };

export interface DashboardApplyResult {
  readonly dashboard: DashboardState;
  readonly changedWidgetIds: readonly string[];
  readonly pointCount: number;
}

export class DashboardInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DashboardInputError";
  }
}

export class DashboardConflictError extends Error {
  constructor(expected: number, actual: number) {
    super(`看板版本已变化:请求基于 revision ${expected},当前为 ${actual};请重新读取看板后重试`);
    this.name = "DashboardConflictError";
  }
}

function assertSessionId(sessionId: string): void {
  if (!SESSION_ID_PATTERN.test(sessionId)) throw new DashboardInputError("会话 ID 无效");
}

function dashboardPath(rootDir: string, sessionId: string): string {
  assertSessionId(sessionId);
  return path.join(rootDir, sessionId, DASHBOARD_FILENAME);
}

function parseDashboardDocument(value: unknown, identities?: readonly DashboardIdentity[]): DashboardDocument {
  if (typeof value !== "object" || value === null || Array.isArray(value) || !("schemaVersion" in value)) {
    throw new DashboardInputError("看板文件结构无效");
  }
  const legacyIdentity = identities ?? [{ id: "default", title: "OEE综合看板" }];
  let entries: unknown[];
  if (value.schemaVersion === 1 && "baseline" in value && "current" in value && legacyIdentity.length === 1) {
    entries = [{ ...legacyIdentity[0], baseline: value.baseline, current: value.current }];
  } else if (value.schemaVersion === 2 && "dashboards" in value && Array.isArray(value.dashboards)) {
    entries = value.dashboards;
  } else throw new DashboardInputError("看板文件结构无效");
  if (!entries.length) throw new DashboardInputError("会话看板不能为空");
  const seen = new Set<string>();
  const dashboards = entries.map((entry): DashboardEntry => {
    if (!entry || typeof entry !== "object" || !("id" in entry) || typeof entry.id !== "string" ||
        !DASHBOARD_ID_PATTERN.test(entry.id) || seen.has(entry.id) || !("title" in entry) ||
        typeof entry.title !== "string" || !entry.title.trim() || entry.title.length > 120 ||
        !("baseline" in entry) || !("current" in entry)) throw new DashboardInputError("看板条目结构无效或 ID 重复");
    seen.add(entry.id);
    if (Buffer.byteLength(JSON.stringify({ schemaVersion: 1, baseline: entry.baseline, current: entry.current })) > MAX_DASHBOARD_FILE_BYTES) throw new DashboardInputError("单个看板文件大小无效");
    try {
      const baseline = parseDashboardState(entry.baseline, "$dashboard.baseline");
      const current = parseDashboardState(entry.current, "$dashboard.current");
      if (baseline.revision !== 0) throw new DashboardInputError("看板 baseline revision 必须为 0");
      // Display compatibility also applies to saved sessions, independently of new publications.
      return { id: entry.id, title: entry.title,
        baseline: { ...baseline, widgets: baseline.widgets.map(formatMachineAnalysisWidget) },
        current: { ...current, widgets: current.widgets.map(formatMachineAnalysisWidget) } };
    } catch (error) {
      throw new DashboardInputError(error instanceof Error ? error.message : "看板文件结构无效");
    }
  });
  if (identities && (dashboards.length !== identities.length || dashboards.some((entry, index) => entry.id !== identities[index]?.id))) {
    throw new DashboardInputError("看板文件与会话绑定不一致");
  }
  return { schemaVersion: 2, dashboards };
}

function readDocument(filePath: string, identities?: readonly DashboardIdentity[]): DashboardDocument | null {
  if (!existsSync(filePath)) return null;
  const metadata = lstatSync(filePath);
  if (!metadata.isFile() || metadata.isSymbolicLink()) throw new DashboardInputError("看板文件类型无效");
  if (metadata.size < 1 || (identities && metadata.size > (MAX_DASHBOARD_FILE_BYTES + 1024) * identities.length + 64)) {
    throw new DashboardInputError("看板文件大小无效");
  }
  try {
    const value: unknown = JSON.parse(readFileSync(filePath, "utf8"));
    const document = parseDashboardDocument(value, identities);
    const maximum = typeof value === "object" && value !== null && "schemaVersion" in value && value.schemaVersion === 1
      ? MAX_DASHBOARD_FILE_BYTES : (MAX_DASHBOARD_FILE_BYTES + 1024) * document.dashboards.length + 64;
    if (metadata.size > maximum) throw new DashboardInputError("看板文件大小无效");
    return document;
  } catch (error) {
    if (error instanceof DashboardInputError) throw error;
    throw new DashboardInputError("看板文件无法解析");
  }
}

function writeDocument(filePath: string, document: DashboardDocument): void {
  const payload = JSON.stringify(document);
  for (const entry of document.dashboards) {
    if (Buffer.byteLength(JSON.stringify({ schemaVersion: 1, baseline: entry.baseline, current: entry.current })) > MAX_DASHBOARD_FILE_BYTES) {
      throw new DashboardInputError(`单个看板文件不能超过 ${MAX_DASHBOARD_FILE_BYTES} 字节`);
    }
  }
  const directory = path.dirname(filePath);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  chmodSync(directory, 0o700);
  const temporaryPath = path.join(directory, `.dashboard-${randomUUID()}.tmp`);
  let fileDescriptor: number | undefined;
  try {
    fileDescriptor = openSync(temporaryPath, "wx", 0o600);
    writeSync(fileDescriptor, payload);
    fsyncSync(fileDescriptor);
    closeSync(fileDescriptor);
    fileDescriptor = undefined;
    renameSync(temporaryPath, filePath);
  } catch (error) {
    if (fileDescriptor !== undefined) closeSync(fileDescriptor);
    rmSync(temporaryPath, { force: true });
    throw error;
  }
}

function parseDashboardData(parsed: unknown): DashboardData {
  if (
    typeof parsed !== "object" || parsed === null || Array.isArray(parsed) ||
    !("columns" in parsed) || !Array.isArray(parsed.columns) ||
    parsed.columns.length === 0 ||
    !parsed.columns.every((column) => typeof column === "string" && column.trim() && column.length <= 80) ||
    new Set(parsed.columns).size !== parsed.columns.length ||
    !("rows" in parsed) || !Array.isArray(parsed.rows)
  ) {
    throw new DashboardInputError("图表数据结构无效,data 必须包含不重复的非空列名和 rows 数组");
  }
  if (parsed.rows.length > MAX_DASHBOARD_ROWS_PER_WIDGET) {
    throw new DashboardInputError(`图表数据不能超过 ${MAX_DASHBOARD_ROWS_PER_WIDGET} 行,请先在 SQL 中聚合或筛选`);
  }
  const rows = parsed.rows.map((value, rowIndex): DashboardRow => {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new DashboardInputError(`图表数据第 ${rowIndex + 1} 行不是对象`);
    }
    for (const [key, cell] of Object.entries(value)) {
      if (cell !== null && typeof cell !== "string" &&
          (typeof cell !== "number" || !Number.isFinite(cell))) {
        throw new DashboardInputError(`图表数据第 ${rowIndex + 1} 行的 ${key} 不是可展示标量`);
      }
    }
    return Object.fromEntries(Object.entries(value)) as DashboardRow;
  });
  const data = { columns: parsed.columns as string[], rows };
  if (Buffer.byteLength(JSON.stringify(data)) > MAX_DASHBOARD_FILE_BYTES) {
    throw new DashboardInputError(`图表数据不能超过 ${MAX_DASHBOARD_FILE_BYTES} 字节`);
  }
  return data;
}

function requestedColumns(widget: DashboardWidgetRequest): readonly string[] {
  if (widget.kind === "kpi") {
    return [widget.encoding.value, ...(widget.encoding.comparison ? [widget.encoding.comparison] : [])];
  }
  if (widget.kind === "overview") {
    return [widget.encoding.value, ...widget.encoding.gauges.map((item) => item.column)];
  }
  if (widget.kind === "line" || widget.kind === "bar" || widget.kind === "stacked-bar") {
    return [widget.encoding.category, ...widget.encoding.series.map((item) => item.column)];
  }
  if (widget.kind === "donut") return [widget.encoding.category, widget.encoding.value];
  if (widget.kind === "table") return widget.encoding.columns.map((column) => column.key);
  return [];
}

function numericColumns(widget: DashboardWidgetRequest): ReadonlySet<string> {
  if (widget.kind === "kpi") {
    return new Set([widget.encoding.value, ...(widget.encoding.comparison ? [widget.encoding.comparison] : [])]);
  }
  if (widget.kind === "overview") {
    return new Set([widget.encoding.value, ...widget.encoding.gauges.map((item) => item.column)]);
  }
  if (widget.kind === "line" || widget.kind === "bar" || widget.kind === "stacked-bar") {
    return new Set(widget.encoding.series.map((item) => item.column));
  }
  if (widget.kind === "donut") return new Set([widget.encoding.value]);
  return new Set();
}

function materializeWidget(
  request: DashboardWidgetRequest,
  source: DashboardData,
): DashboardWidget {
  if ((request.kind === "kpi" || request.kind === "overview") && source.rows.length !== 1) {
    throw new DashboardInputError("KPI 或概览图表数据必须恰好包含一行");
  }
  const columns = [...new Set(requestedColumns(request))];
  const available = new Set(source.columns);
  for (const column of columns) {
    if (!available.has(column)) throw new DashboardInputError(`图表数据中不存在列 ${column}`);
  }
  const numbers = numericColumns(request);
  let data = source.rows.map((row, rowIndex): DashboardRow => {
    const output: Record<string, string | number | null> = {};
    for (const column of columns) {
      if (!Object.hasOwn(row, column)) throw new DashboardInputError(`第 ${rowIndex + 1} 行缺少列 ${column}`);
      const value = row[column];
      if (value !== null && typeof value !== "string" && typeof value !== "number") {
        throw new DashboardInputError(`第 ${rowIndex + 1} 行的 ${column} 不是可展示标量`);
      }
      if (typeof value === "number" && !Number.isFinite(value)) {
        throw new DashboardInputError(`第 ${rowIndex + 1} 行的 ${column} 不是有限数字`);
      }
      if (numbers.has(column) && value !== null && typeof value !== "number") {
        throw new DashboardInputError(`第 ${rowIndex + 1} 行的 ${column} 必须是数字或 null`);
      }
      output[column] = value ?? null;
    }
    return output;
  });
  // Keep original data keys/IDs for audit; only display bindings point at formatted labels.
  const displayColumns = new Map<string, string>();
  const occupied = new Set(columns);
  for (const column of columns.filter((column) => !numbers.has(column))) {
    const formatCell = (value: string): string => /^(?:machine|machine_id|tool_name|机台|机台号)$/iu.test(column)
      ? machineLabel(value.split("/").at(-1)!) : formatMachineMentions(value);
    if (!data.some((row) => typeof row[column] === "string" && formatCell(row[column]) !== row[column])) continue;
    let index = displayColumns.size;
    while (occupied.has("display_machine_" + index)) index++;
    const displayColumn = "display_machine_" + index;
    occupied.add(displayColumn); displayColumns.set(column, displayColumn);
    data = data.map((row) => ({ ...row, [displayColumn]: typeof row[column] === "string" ? formatCell(row[column]) : row[column] ?? null }));
  }
  let encoding = request.encoding;
  if (request.kind === "table") encoding = { ...request.encoding, columns: request.encoding.columns.map((column) => ({
    ...column, key: displayColumns.get(column.key) ?? column.key, label: formatMachineMentions(column.label),
  })) };
  else if (request.kind === "line" || request.kind === "bar" || request.kind === "stacked-bar") encoding = {
    ...request.encoding, category: displayColumns.get(request.encoding.category) ?? request.encoding.category,
    series: request.encoding.series.map((series) => ({ ...series, name: formatMachineMentions(series.name) })),
  };
  else if (request.kind === "donut") encoding = { ...request.encoding, category: displayColumns.get(request.encoding.category) ?? request.encoding.category };
  else if (request.kind === "overview") encoding = { ...request.encoding,
    ...(request.encoding.label ? { label: formatMachineMentions(request.encoding.label) } : {}),
    ...(request.encoding.description ? { description: formatMachineMentions(request.encoding.description) } : {}),
    gauges: request.encoding.gauges.map((gauge) => ({ ...gauge, name: formatMachineMentions(gauge.name) })),
  };
  return parseDashboardState({
    schemaVersion: DASHBOARD_SCHEMA_VERSION,
    revision: 0,
    dataAsOf: new Date().toISOString(),
    dateRange: { start: null, end: null },
    widgets: [{ ...request, encoding, data, title: formatMachineMentions(request.title), subtitle: formatMachineMentions(request.subtitle),
      metricDefinition: formatMachineMentions(request.metricDefinition), warnings: request.warnings.map((warning) => formatMachineMentions(warning)) }],
  }).widgets[0] as DashboardWidget;
}

function sameIds(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && new Set(left).size === left.length &&
    left.every((value) => right.includes(value));
}

export class SessionDashboardStore {
  readonly #rootDir: string;
  readonly #loadInitialDashboard: InitialDashboardProvider;
  readonly #identities: DashboardIdentityProvider;
  readonly #previews = new Map<string, readonly SessionDashboard[]>();
  readonly #activeDashboardIds = new Map<string, string>();

  constructor(artifacts: ArtifactStore, loadInitialDashboard: InitialDashboardProvider,
    identities: DashboardIdentityProvider = () => undefined) {
    this.#rootDir = artifacts.rootDir;
    this.#loadInitialDashboard = loadInitialDashboard;
    this.#identities = identities;
  }

  initialize(sessionId: string, baseline: DashboardState | readonly SessionDashboard[]): void {
    const values = Array.isArray(baseline) ? baseline : [{ ...(this.#identities(sessionId)?.[0] ?? { id: "default", title: "OEE综合看板" }), state: baseline }];
    const document = parseDashboardDocument({ schemaVersion: 2, dashboards: values.map((item) => ({
      id: item.id, title: item.title, baseline: item.state, current: item.state,
    })) }, this.#identities(sessionId) ?? values);
    writeDocument(dashboardPath(this.#rootDir, sessionId), document);
    this.forget(sessionId);
  }

  forget(sessionId: string): void {
    this.#previews.delete(sessionId);
    this.#activeDashboardIds.delete(sessionId);
  }

  dispose(): void {
    this.#previews.clear();
    this.#activeDashboardIds.clear();
  }

  setActiveDashboard(sessionId: string, dashboardId: string): void {
    const identities = this.#identities(sessionId) ?? this.#previews.get(sessionId) ?? [{ id: "default" }];
    if (!identities.some((item) => item.id === dashboardId)) throw new DashboardInputError("会话中不存在看板:" + dashboardId);
    this.#activeDashboardIds.set(sessionId, dashboardId);
  }

  activeDashboardId(sessionId: string): string {
    return this.#activeDashboardIds.get(sessionId) ?? this.#identities(sessionId)?.[0]?.id ?? this.#previews.get(sessionId)?.[0]?.id ?? "default";
  }

  clearActiveDashboard(sessionId: string): void {
    this.#activeDashboardIds.delete(sessionId);
  }

  #initialDocument(sessionId: string): DashboardDocument {
    let values = this.#previews.get(sessionId);
    if (!values) {
      const initial = this.#loadInitialDashboard(sessionId);
      values = Array.isArray(initial) ? initial : [{ ...(this.#identities(sessionId)?.[0] ?? { id: "default", title: "OEE综合看板" }), state: initial as DashboardState }];
      const pinned = parseDashboardDocument({ schemaVersion: 2, dashboards: values.map((item) => ({
        id: item.id, title: item.title, baseline: item.state, current: item.state,
      })) }, this.#identities(sessionId));
      values = pinned.dashboards.map((item) => ({ id: item.id, title: item.title, state: item.baseline }));
      this.#previews.set(sessionId, values);
    }
    return parseDashboardDocument({ schemaVersion: 2, dashboards: values.map((item) => ({
      id: item.id, title: item.title, baseline: item.state, current: item.state,
    })) }, this.#identities(sessionId));
  }

  #document(sessionId: string): DashboardDocument {
    return readDocument(dashboardPath(this.#rootDir, sessionId), this.#identities(sessionId)) ?? this.#initialDocument(sessionId);
  }

  listOrPreview(sessionId: string): readonly SessionDashboard[] {
    return this.#document(sessionId).dashboards.map((item) => ({ id: item.id, title: item.title, state: item.current }));
  }

  listOrInitialize(sessionId: string): readonly SessionDashboard[] {
    const filePath = dashboardPath(this.#rootDir, sessionId);
    const existing = readDocument(filePath, this.#identities(sessionId));
    const document = existing ?? this.#initialDocument(sessionId);
    if (!existing) writeDocument(filePath, document);
    this.#previews.delete(sessionId);
    return document.dashboards.map((item) => ({ id: item.id, title: item.title, state: item.current }));
  }

  #select(values: readonly SessionDashboard[], dashboardId?: string): SessionDashboard {
    if (dashboardId === undefined && values.length !== 1) throw new DashboardInputError("多看板会话必须指定看板 ID");
    const item = dashboardId === undefined ? values[0] : values.find((item) => item.id === dashboardId);
    if (!item) throw new DashboardInputError("会话中不存在看板:" + dashboardId);
    return item;
  }

  loadOrPreview(sessionId: string, dashboardId?: string): DashboardState {
    return this.#select(this.listOrPreview(sessionId), dashboardId).state;
  }

  loadOrInitialize(sessionId: string, dashboardId?: string): DashboardState {
    this.#select(this.listOrPreview(sessionId), dashboardId);
    return this.#select(this.listOrInitialize(sessionId), dashboardId).state;
  }

  apply(sessionId: string, command: DashboardCommand, dashboardId?: string): DashboardApplyResult {
    const filePath = dashboardPath(this.#rootDir, sessionId);
    const collection = this.#document(sessionId);
    const selected = this.#select(collection.dashboards.map((item) => ({ ...item, state: item.current })), dashboardId);
    const document = collection.dashboards.find((item) => item.id === selected.id)!;
    if (command.baseRevision !== document.current.revision) {
      throw new DashboardConflictError(command.baseRevision, document.current.revision);
    }
    let widgets: readonly DashboardWidget[] = document.current.widgets;
    let dataAsOf = document.current.dataAsOf;
    let dateRange = document.current.dateRange;
    let changedWidgetIds: readonly string[] = [];
    let pointCount = 0;

    if (command.action === "upsert") {
      const nextWidget = materializeWidget(command.widget, parseDashboardData(command.data));
      const existingIndex = widgets.findIndex((widget) => widget.id === nextWidget.id);
      if (existingIndex < 0) {
        if (widgets.length >= MAX_DASHBOARD_WIDGETS) {
          throw new DashboardInputError(`看板最多包含 ${MAX_DASHBOARD_WIDGETS} 个组件`);
        }
        widgets = [...widgets, nextWidget];
      } else {
        widgets = widgets.map((widget, index) => index === existingIndex ? nextWidget : widget);
      }
      dataAsOf = new Date().toISOString();
      dateRange = command.dateRange;
      changedWidgetIds = [nextWidget.id];
      pointCount = nextWidget.data.length;
    } else if (command.action === "remove") {
      if (!widgets.some((widget) => widget.id === command.widgetId)) {
        throw new DashboardInputError(`看板中不存在组件 ${command.widgetId}`);
      }
      widgets = widgets.filter((widget) => widget.id !== command.widgetId);
      changedWidgetIds = [command.widgetId];
    } else if (command.action === "reorder") {
      const currentIds = widgets.map((widget) => widget.id);
      if (!sameIds(command.widgetIds, currentIds)) {
        throw new DashboardInputError("reorder 必须且只能包含当前全部组件 ID");
      }
      const byId = new Map(widgets.map((widget) => [widget.id, widget]));
      widgets = command.widgetIds.map((id) => byId.get(id) as DashboardWidget);
      changedWidgetIds = [...command.widgetIds];
    } else {
      widgets = document.baseline.widgets;
      dataAsOf = document.baseline.dataAsOf;
      dateRange = document.baseline.dateRange;
      changedWidgetIds = document.baseline.widgets.map((widget) => widget.id);
      pointCount = document.baseline.widgets.reduce((total, widget) => total + widget.data.length, 0);
    }

    const dashboard = parseDashboardState({
      schemaVersion: DASHBOARD_SCHEMA_VERSION,
      revision: document.current.revision + 1,
      dataAsOf,
      dateRange,
      widgets,
    });
    writeDocument(filePath, { ...collection, dashboards: collection.dashboards.map((entry) =>
      entry.id === selected.id ? { ...entry, current: dashboard } : entry) });
    this.#previews.delete(sessionId);
    return { dashboard, changedWidgetIds, pointCount };
  }
}
