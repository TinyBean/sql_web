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
  type DashboardTableEncoding,
  type DashboardWidget,
  type DashboardWidgetSize,
} from "../../shared/dashboard.ts";
import type { QueryResult } from "../database/database.ts";
import type { ArtifactStore, SessionArtifactStore } from "./artifact-store.ts";
import type { AppLogger } from "../logger.ts";
import { readDefaultDashboard } from "./default-dashboard-store.ts";

const DASHBOARD_FILENAME = "dashboard.json";
const SESSION_ID_PATTERN = /^[A-Za-z0-9-]{8,100}$/u;

interface DashboardDocument {
  readonly schemaVersion: typeof DASHBOARD_SCHEMA_VERSION;
  readonly baseline: DashboardState;
  readonly current: DashboardState;
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

export type DashboardCommand =
  | {
      readonly action: "upsert";
      readonly baseRevision: number;
      readonly snapshot: string;
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
    super(`看板版本已变化：请求基于 revision ${expected}，当前为 ${actual}；请重新读取看板后重试`);
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

function parseDashboardDocument(value: unknown): DashboardDocument {
  if (
    typeof value !== "object" || value === null || Array.isArray(value) ||
    !("schemaVersion" in value) || value.schemaVersion !== DASHBOARD_SCHEMA_VERSION ||
    !("baseline" in value) || !("current" in value)
  ) {
    throw new DashboardInputError("看板文件结构无效");
  }
  try {
    const baseline = parseDashboardState(value.baseline, "$dashboard.baseline");
    const current = parseDashboardState(value.current, "$dashboard.current");
    if (baseline.revision !== 0) throw new DashboardInputError("看板 baseline revision 必须为 0");
    return { schemaVersion: DASHBOARD_SCHEMA_VERSION, baseline, current };
  } catch (error) {
    if (error instanceof DashboardInputError) throw error;
    throw new DashboardInputError(error instanceof Error ? error.message : "看板文件结构无效");
  }
}

function readDocument(filePath: string): DashboardDocument | null {
  if (!existsSync(filePath)) return null;
  const metadata = lstatSync(filePath);
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new DashboardInputError("看板文件类型无效");
  }
  if (metadata.size < 1 || metadata.size > MAX_DASHBOARD_FILE_BYTES) {
    throw new DashboardInputError("看板文件大小无效");
  }
  try {
    return parseDashboardDocument(JSON.parse(readFileSync(filePath, "utf8")) as unknown);
  } catch (error) {
    if (error instanceof DashboardInputError) throw error;
    throw new DashboardInputError("看板文件无法解析");
  }
}

function writeDocument(filePath: string, document: DashboardDocument): void {
  const payload = JSON.stringify(document);
  if (Buffer.byteLength(payload) > MAX_DASHBOARD_FILE_BYTES) {
    throw new DashboardInputError(`看板文件不能超过 ${MAX_DASHBOARD_FILE_BYTES} 字节`);
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

function snapshotRows(artifacts: SessionArtifactStore, snapshotName: string): QueryResult {
  const snapshot = artifacts.resolveDataSnapshot(snapshotName);
  if (snapshot.rowCount > MAX_DASHBOARD_ROWS_PER_WIDGET) {
    throw new DashboardInputError(
      `图表快照不能超过 ${MAX_DASHBOARD_ROWS_PER_WIDGET} 行，请先在 SQL 中聚合或筛选`,
    );
  }
  if (snapshot.byteCount > MAX_DASHBOARD_FILE_BYTES) {
    throw new DashboardInputError(`图表快照不能超过 ${MAX_DASHBOARD_FILE_BYTES} 字节`);
  }
  const parsed: unknown = JSON.parse(readFileSync(snapshot.filePath, "utf8"));
  if (
    typeof parsed !== "object" || parsed === null || Array.isArray(parsed) ||
    !("columns" in parsed) || !Array.isArray(parsed.columns) ||
    !parsed.columns.every((column) => typeof column === "string") ||
    new Set(parsed.columns).size !== parsed.columns.length ||
    !("rows" in parsed) || !Array.isArray(parsed.rows) ||
    !("rowCount" in parsed) || parsed.rowCount !== parsed.rows.length ||
    !("truncated" in parsed) || parsed.truncated !== false
  ) {
    throw new DashboardInputError("图表数据快照结构无效");
  }
  const rows = parsed.rows.map((value, rowIndex): DashboardRow => {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new DashboardInputError(`图表数据快照第 ${rowIndex + 1} 行不是对象`);
    }
    const decoded: Record<string, string | number | null> = {};
    for (const [key, cell] of Object.entries(value)) {
      if (cell !== null && typeof cell !== "string" &&
          (typeof cell !== "number" || !Number.isFinite(cell))) {
        throw new DashboardInputError(`图表数据快照第 ${rowIndex + 1} 行的 ${key} 不是可展示标量`);
      }
      decoded[key] = cell as string | number | null;
    }
    return decoded;
  });
  return {
    columns: parsed.columns,
    rows,
    rowCount: rows.length,
    truncated: false,
  };
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
  snapshot: QueryResult,
): DashboardWidget {
  if ((request.kind === "kpi" || request.kind === "overview") && snapshot.rows.length !== 1) {
    throw new DashboardInputError("KPI 或概览图表快照必须恰好包含一行");
  }
  const columns = [...new Set(requestedColumns(request))];
  const available = new Set(snapshot.columns);
  for (const column of columns) {
    if (!available.has(column)) throw new DashboardInputError(`图表快照中不存在列 ${column}`);
  }
  const numbers = numericColumns(request);
  const data = snapshot.rows.map((row, rowIndex): DashboardRow => {
    const output: Record<string, string | number | null> = {};
    for (const column of columns) {
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
  return parseDashboardState({
    schemaVersion: DASHBOARD_SCHEMA_VERSION,
    revision: 0,
    dataAsOf: new Date().toISOString(),
    dateRange: { start: null, end: null },
    widgets: [{ ...request, data }],
  }).widgets[0] as DashboardWidget;
}

function sameIds(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && new Set(left).size === left.length &&
    left.every((value) => right.includes(value));
}

export class DashboardModule {
  readonly #artifacts: ArtifactStore;
  readonly #defaultPath: string | undefined;
  readonly #logger: Pick<AppLogger, "info" | "error"> | undefined;
  readonly #previews = new Map<string, DashboardState>();

  constructor(artifacts: ArtifactStore, defaultPath?: string, logger?: Pick<AppLogger, "info" | "error">) {
    this.#artifacts = artifacts;
    this.#defaultPath = defaultPath;
    this.#logger = logger;
  }

  forget(sessionId: string): void {
    this.#previews.delete(sessionId);
  }

  dispose(): void {
    this.#previews.clear();
  }

  #initialState(sessionId: string): DashboardState {
    let state = this.#previews.get(sessionId);
    if (!state) {
      state = readDefaultDashboard(this.#defaultPath, this.#logger);
      this.#previews.set(sessionId, state);
    }
    return parseDashboardState(state);
  }

  loadOrPreview(sessionId: string): DashboardState {
    const filePath = dashboardPath(this.#artifacts.rootDir, sessionId);
    return readDocument(filePath)?.current ?? this.#initialState(sessionId);
  }

  loadOrInitialize(sessionId: string): DashboardState {
    const filePath = dashboardPath(this.#artifacts.rootDir, sessionId);
    const existing = readDocument(filePath);
    if (existing) return existing.current;
    const baseline = this.#initialState(sessionId);
    writeDocument(filePath, {
      schemaVersion: DASHBOARD_SCHEMA_VERSION,
      baseline,
      current: baseline,
    });
    this.forget(sessionId);
    return baseline;
  }

  apply(sessionId: string, command: DashboardCommand): DashboardApplyResult {
    const filePath = dashboardPath(this.#artifacts.rootDir, sessionId);
    const document = readDocument(filePath) ?? (() => {
      const baseline = this.#initialState(sessionId);
      return { schemaVersion: DASHBOARD_SCHEMA_VERSION, baseline, current: baseline } as const;
    })();
    if (command.baseRevision !== document.current.revision) {
      throw new DashboardConflictError(command.baseRevision, document.current.revision);
    }
    let widgets: readonly DashboardWidget[] = document.current.widgets;
    let dataAsOf = document.current.dataAsOf;
    let dateRange = document.current.dateRange;
    let changedWidgetIds: readonly string[] = [];
    let pointCount = 0;

    if (command.action === "upsert") {
      const snapshot = snapshotRows(this.#artifacts.forSession(sessionId), command.snapshot);
      const nextWidget = materializeWidget(command.widget, snapshot);
      const existingIndex = widgets.findIndex((widget) => widget.id === nextWidget.id);
      if (existingIndex < 0) {
        if (widgets.length >= MAX_DASHBOARD_WIDGETS) {
          throw new DashboardInputError(`看板最多包含 ${MAX_DASHBOARD_WIDGETS} 个组件`);
        }
        widgets = [...widgets, nextWidget];
      } else {
        widgets = widgets.map((widget, index) => index === existingIndex ? nextWidget : widget);
      }
      const descriptor = this.#artifacts.forSession(sessionId).resolveDataSnapshot(command.snapshot);
      dataAsOf = descriptor.createdAt;
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
    writeDocument(filePath, { ...document, current: dashboard });
    this.forget(sessionId);
    return { dashboard, changedWidgetIds, pointCount };
  }
}
