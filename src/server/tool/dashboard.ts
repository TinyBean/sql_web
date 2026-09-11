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
import type { AppDatabase, QueryResult } from "../database/database.ts";
import type { ArtifactStore, SessionArtifactStore } from "./artifact-store.ts";
import { getDefaultTestOeeSql } from "../skills/test-oee-calculator/assets/test-oee-calculator.ts";

const DASHBOARD_FILENAME = "dashboard.json";
const SESSION_ID_PATTERN = /^[A-Za-z0-9-]{8,100}$/u;
const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/u;

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

function queryRows(database: AppDatabase, sql: string): readonly DashboardRow[] {
  const result = database.query(sql, undefined, { maxRows: 200 });
  if (result.truncated) throw new DashboardInputError("默认看板查询结果超过 200 行");
  return result.rows;
}

function scalarString(row: DashboardRow | undefined, key: string): string | null {
  const value = row?.[key];
  return typeof value === "string" ? value : null;
}

function validDate(value: string | null): value is string {
  if (!value || !ISO_DATE_PATTERN.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function shiftDate(value: string, days: number): string {
  const date = new Date(`${value}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function dateSequence(start: string, count: number): string[] {
  return Array.from({ length: count }, (_, index) => shiftDate(start, index));
}

function numeric(value: string | number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function percent(value: number | null): number | null {
  return value === null ? null : value * 100;
}

function rowsByKey(rows: readonly DashboardRow[], key: string): Map<string, DashboardRow> {
  const mapped = new Map<string, DashboardRow>();
  for (const row of rows) {
    const value = row[key];
    if (typeof value === "string") mapped.set(value, row);
  }
  return mapped;
}

function average(values: readonly (number | null)[]): number | null {
  let total = 0;
  let count = 0;
  for (const value of values) {
    if (value === null) continue;
    total += value;
    count += 1;
  }
  return count ? total / count : null;
}

const FACTOR_DEFINITIONS = [
  {
    id: "availability",
    title: "Availability",
    sourceColumn: "availability",
    overviewColumn: "availability",
    metricDefinition: "Machine_Running 秒数 / (当日机台数 × 86400)",
  },
  {
    id: "dut-on",
    title: "DUT-On",
    sourceColumn: "dut_on",
    overviewColumn: "dut_on",
    metricDefinition: "SUM(IN_QTY) / SUM(DUT_NUM)",
  },
  {
    id: "test-time",
    title: "Test Time",
    sourceColumn: "test_time_performance",
    overviewColumn: "test_time",
    metricDefinition: "0.2% 截尾平均测试秒数 × SUM(TD_Label) / SUM(测试秒数)",
  },
  {
    id: "yield",
    title: "Yield",
    sourceColumn: "final_yield",
    overviewColumn: "yield",
    metricDefinition: "SUM(OUT_QTY) / SUM(IN_QTY)",
  },
] as const;

function dashboardWarnings(rows: readonly DashboardRow[]): string[] {
  const warnings: string[] = [];
  const calculable = rows.filter((row) => numeric(row["daily_test_oee"]) !== null).length;
  if (calculable < rows.length) {
    warnings.push(`最近 7 个业务日共有 ${calculable}/${rows.length} 个 MT/ST 日结果可计算`);
  }
  const availabilityMissing = rows.filter((row) => numeric(row["availability_rows"]) === 0).length;
  const dutMissing = rows.filter((row) => numeric(row["dut_rows"]) === null).length;
  if (availabilityMissing) warnings.push(`Availability 缺少 ${availabilityMissing} 个业务日类型组合`);
  if (dutMissing) warnings.push(`DUT 缺少 ${dutMissing} 个业务日类型组合`);
  return warnings;
}

function factorWarnings(
  rows: readonly DashboardRow[],
  title: string,
  sourceColumn: string,
  commonWarnings: readonly string[],
): string[] {
  const missing = rows.filter((row) => numeric(row[sourceColumn]) === null).length;
  return missing
    ? [...commonWarnings, `${title} 有 ${missing}/${rows.length} 个业务日类型组合无法计算`]
    : [...commonWarnings];
}

function emptyLineWidget(
  id: string,
  title: string,
  metricDefinition: string,
  warning: readonly string[],
): DashboardWidget {
  return {
    id: `${id}-trend-7d`,
    kind: "line",
    title: `${title} 日趋势`,
    subtitle: "等待可用数据",
    size: "medium",
    data: [],
    encoding: {
      category: "date",
      series: [{ name: "MT", column: "mt" }, { name: "ST", column: "st" }],
    },
    format: { unit: "%", precision: 1 },
    metricDefinition,
    warnings: warning,
  };
}

function emptyDefaultDashboard(): DashboardState {
  const now = new Date().toISOString();
  const warning = ["Availability 或 DUT 数据为空，暂时无法计算默认 Test OEE 看板"];
  return {
    schemaVersion: DASHBOARD_SCHEMA_VERSION,
    revision: 0,
    dataAsOf: now,
    dateRange: { start: null, end: null },
    widgets: [
      {
        id: "overall-oee-overview",
        kind: "overview",
        title: "Overall OEE",
        subtitle: "等待可用数据",
        size: "wide",
        data: [{ overall_oee: null, availability: null, dut_on: null, test_time: null, yield: null }],
        encoding: {
          value: "overall_oee",
          label: "Overall OEE",
          description: "等待可用数据后计算",
          gauges: [
            { name: "Availability", column: "availability" },
            { name: "DUT-On", column: "dut_on" },
            { name: "Test Time", column: "test_time" },
            { name: "Yield", column: "yield" },
          ],
        },
        format: { unit: "%", precision: 2 },
        metricDefinition: "Overall OEE = Availability × DUT-On × Test Time × Yield",
        warnings: warning,
      },
      ...FACTOR_DEFINITIONS.map((factor) => emptyLineWidget(
        factor.id,
        factor.title,
        factor.metricDefinition,
        warning,
      )),
    ],
  };
}

function buildDefaultDashboard(database: AppDatabase): DashboardState {
  const bounds = queryRows(database, `SELECT
    (SELECT MAX(date(substr(date,1,10))) FROM oee_availability) AS availability_end,
    (SELECT MAX(date(substr(date,1,10))) FROM oee_dut_utilization) AS dut_end`)[0];
  const availabilityEnd = scalarString(bounds, "availability_end");
  const dutEnd = scalarString(bounds, "dut_end");
  const availableEnds = [availabilityEnd, dutEnd].filter(validDate);
  if (!availableEnds.length) return emptyDefaultDashboard();
  const end = availableEnds.length === 2
    ? availableEnds.sort()[0] as string
    : availableEnds[0] as string;
  const start = shiftDate(end, -6);
  const dates = dateSequence(start, 7);
  const dailyRows = queryRows(database, getDefaultTestOeeSql(start, end).sql);
  const warnings = dashboardWarnings(dailyRows);
  if (!validDate(availabilityEnd)) warnings.push("Availability 数据为空");
  if (!validDate(dutEnd)) warnings.push("DUT 数据为空");
  const byDayKind = rowsByKey(
    dailyRows.map((row) => ({ ...row, key: `${String(row["day"])}:${String(row["kind"])}` })),
    "key",
  );
  const calculableRows = dailyRows.filter((row) => numeric(row["daily_test_oee"]) !== null);
  const overviewData: DashboardRow = {
    overall_oee: percent(average(calculableRows.map((row) => numeric(row["daily_test_oee"])))),
    availability: percent(average(calculableRows.map((row) => numeric(row["availability"])))),
    dut_on: percent(average(calculableRows.map((row) => numeric(row["dut_on"])))),
    test_time: percent(average(calculableRows.map((row) => numeric(row["test_time_performance"])))),
    yield: percent(average(calculableRows.map((row) => numeric(row["final_yield"])))),
  };

  const factorWidget = (factor: typeof FACTOR_DEFINITIONS[number]): DashboardWidget => ({
    id: `${factor.id}-trend-7d`,
    kind: "line",
    title: `${factor.title} 日趋势`,
    subtitle: `${start} 至 ${end} · MT / ST`,
    size: "medium",
    data: dates.map((date) => ({
      date,
      mt: percent(numeric(byDayKind.get(`${date}:MT`)?.[factor.sourceColumn])),
      st: percent(numeric(byDayKind.get(`${date}:ST`)?.[factor.sourceColumn])),
    })),
    encoding: {
      category: "date",
      series: [{ name: "MT", column: "mt" }, { name: "ST", column: "st" }],
    },
    format: { unit: "%", precision: 1 },
    metricDefinition: factor.metricDefinition,
    warnings: factorWarnings(dailyRows, factor.title, factor.sourceColumn, warnings),
  });

  return parseDashboardState({
    schemaVersion: DASHBOARD_SCHEMA_VERSION,
    revision: 0,
    dataAsOf: new Date().toISOString(),
    dateRange: { start, end },
    widgets: [
      {
        id: "overall-oee-overview",
        kind: "overview",
        title: "Overall OEE",
        subtitle: `${start} 至 ${end} · ${calculableRows.length}/${dailyRows.length} 个 MT/ST 日结果可计算`,
        size: "wide",
        data: [overviewData],
        encoding: {
          value: "overall_oee",
          label: `${dates.length} 日 Overall OEE`,
          description: "AVG(MT / ST DAILY OEE)",
          gauges: [
            { name: "Availability", column: "availability" },
            { name: "DUT-On", column: "dut_on" },
            { name: "Test Time", column: "test_time" },
            { name: "Yield", column: "yield" },
          ],
        },
        format: { unit: "%", precision: 2 },
        metricDefinition: "Overall OEE 为可计算 MT/ST 日 OEE 的等权平均；四个乘数为同一组日类型结果的等权平均",
        warnings,
      },
      ...FACTOR_DEFINITIONS.map(factorWidget),
    ],
  });
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
  readonly #database: AppDatabase;
  readonly #artifacts: ArtifactStore;

  constructor(database: AppDatabase, artifacts: ArtifactStore) {
    this.#database = database;
    this.#artifacts = artifacts;
  }

  loadOrPreview(sessionId: string): DashboardState {
    const filePath = dashboardPath(this.#artifacts.rootDir, sessionId);
    return readDocument(filePath)?.current ?? buildDefaultDashboard(this.#database);
  }

  loadOrInitialize(sessionId: string): DashboardState {
    const filePath = dashboardPath(this.#artifacts.rootDir, sessionId);
    const existing = readDocument(filePath);
    if (existing) return existing.current;
    const baseline = buildDefaultDashboard(this.#database);
    writeDocument(filePath, {
      schemaVersion: DASHBOARD_SCHEMA_VERSION,
      baseline,
      current: baseline,
    });
    return baseline;
  }

  apply(sessionId: string, command: DashboardCommand): DashboardApplyResult {
    const filePath = dashboardPath(this.#artifacts.rootDir, sessionId);
    const document = readDocument(filePath) ?? (() => {
      const baseline = buildDefaultDashboard(this.#database);
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
    return { dashboard, changedWidgetIds, pointCount };
  }
}
