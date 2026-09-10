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
  type DashboardRow,
  type DashboardState,
  type DashboardTableEncoding,
  type DashboardWidget,
  type DashboardWidgetSize,
} from "../../shared/dashboard.ts";
import type { AppDatabase, QueryResult } from "../database/database.ts";
import type { ArtifactStore, SessionArtifactStore } from "./artifact-store.ts";
import { getTestOeeSqlExpressions } from "../skills/test-oee-calculator/assets/test-oee-calculator.ts";

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

function ratio(numerator: number | null, denominator: number | null): number | null {
  return numerator === null || denominator === null || denominator === 0
    ? null
    : numerator / denominator;
}

function percent(value: number | null): number | null {
  return value === null ? null : value * 100;
}

interface OeeParts {
  readonly availability: number | null;
  readonly dutOn: number | null;
  readonly yield: number | null;
  readonly oee: number | null;
}

function oeeParts(
  runningSeconds: number | null,
  machineCount: number | null,
  dayCount: number,
  inputQuantity: number | null,
  outputQuantity: number | null,
  dutCount: number | null,
): OeeParts {
  const availability = ratio(
    runningSeconds,
    machineCount === null ? null : machineCount * dayCount * 86_400,
  );
  const dutOn = ratio(inputQuantity, dutCount);
  const yieldValue = ratio(outputQuantity, inputQuantity);
  return {
    availability,
    dutOn,
    yield: yieldValue,
    oee: availability === null || dutOn === null || yieldValue === null
      ? null
      : availability * dutOn * yieldValue,
  };
}

function rowsByKey(rows: readonly DashboardRow[], key: string): Map<string, DashboardRow> {
  const mapped = new Map<string, DashboardRow>();
  for (const row of rows) {
    const value = row[key];
    if (typeof value === "string") mapped.set(value, row);
  }
  return mapped;
}

function formatPartsSubtitle(parts: OeeParts): string {
  const display = (value: number | null): string => value === null ? "—" : `${(value * 100).toFixed(1)}%`;
  return `Availability ${display(parts.availability)} · DUT-On ${display(parts.dutOn)} · Yield ${display(parts.yield)}`;
}

function missingWarnings(
  dates: readonly string[],
  availabilityByDate: ReadonlyMap<string, DashboardRow>,
  dutByDate: ReadonlyMap<string, DashboardRow>,
): string[] {
  const warnings: string[] = [];
  const availabilityMissing = dates.filter((date) => numeric(availabilityByDate.get(date)?.["row_count"]) === null);
  const dutMissing = dates.filter((date) => numeric(dutByDate.get(date)?.["row_count"]) === null);
  if (availabilityMissing.length) warnings.push(`Availability 缺失日期：${availabilityMissing.join("、")}`);
  if (dutMissing.length) warnings.push(`DUT 缺失日期：${dutMissing.join("、")}`);
  return warnings;
}

function emptyDefaultDashboard(): DashboardState {
  const now = new Date().toISOString();
  const warning = ["Availability 或 DUT 数据为空，暂时无法计算默认 Test OEE 看板"];
  const kpi = (id: string, title: string): DashboardWidget => ({
    id,
    kind: "kpi",
    title,
    subtitle: "等待可用数据",
    size: "small",
    data: [{ value: null }],
    encoding: { value: "value", comparison: null },
    format: { unit: "%", precision: 2 },
    metricDefinition: "Test OEE = Availability × DUT-On × Yield",
    warnings: warning,
  });
  return {
    schemaVersion: DASHBOARD_SCHEMA_VERSION,
    revision: 0,
    dataAsOf: now,
    dateRange: { start: null, end: null },
    widgets: [
      kpi("mt-test-oee", "MT Test OEE"),
      kpi("st-test-oee", "ST Test OEE"),
      {
        id: "oee-components",
        kind: "bar",
        title: "OEE 组成项",
        subtitle: "Availability、DUT-On 与 Yield",
        size: "medium",
        data: [],
        encoding: {
          category: "kind",
          series: [
            { name: "Availability", column: "availability" },
            { name: "DUT-On", column: "dut_on" },
            { name: "Yield", column: "yield" },
          ],
          orientation: "vertical",
        },
        format: { unit: "%", precision: 1 },
        metricDefinition: "三个组成项按 MT/ST 分别聚合",
        warnings: warning,
      },
      {
        id: "oee-trend-14d",
        kind: "line",
        title: "Test OEE 日趋势",
        subtitle: "最近 14 个自然日",
        size: "wide",
        data: [],
        encoding: {
          category: "date",
          series: [{ name: "MT", column: "mt" }, { name: "ST", column: "st" }],
        },
        format: { unit: "%", precision: 1 },
        metricDefinition: "按自然日计算 Test OEE",
        warnings: warning,
      },
      {
        id: "availability-top10",
        kind: "bar",
        title: "机台 Availability Top 10",
        subtitle: "Machine_Running 时长 / 14 个自然日",
        size: "medium",
        data: [],
        encoding: {
          category: "machine",
          series: [{ name: "Availability", column: "availability" }],
          orientation: "horizontal",
        },
        format: { unit: "%", precision: 1 },
        metricDefinition: "机台 Machine_Running 秒数 / (14 × 86400)",
        warnings: warning,
      },
      {
        id: "data-coverage",
        kind: "line",
        title: "数据覆盖",
        subtitle: "每日事实记录数",
        size: "medium",
        data: [],
        encoding: {
          category: "date",
          series: [
            { name: "Availability", column: "availability_rows" },
            { name: "DUT", column: "dut_rows" },
          ],
        },
        format: { unit: " 行", precision: 0 },
        metricDefinition: "两张事实表按日期统计记录数",
        warnings: warning,
      },
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
  const start = shiftDate(end, -13);
  const dates = dateSequence(start, 14);
  const availabilityExpressions = getTestOeeSqlExpressions("availability", start, end, "a");
  const dutExpressions = getTestOeeSqlExpressions("dut", start, end, "d");
  const availabilityState = availabilityExpressions.availabilityStateExpression;
  if (!availabilityState) throw new DashboardInputError("Availability 状态表达式缺失");

  const machineRows = queryRows(database, `WITH classified AS (
    SELECT a.tool_name AS machine, ${availabilityExpressions.kindExpression} AS kind
    FROM oee_availability a
    WHERE ${availabilityExpressions.lotPredicate}
  )
  SELECT kind, COUNT(DISTINCT machine) AS machine_count
  FROM classified
  WHERE kind IN ('MT','ST')
  GROUP BY kind`);
  const availabilityRows = queryRows(database, `WITH classified AS (
    SELECT substr(a.date,1,10) AS day,
           ${availabilityExpressions.kindExpression} AS kind,
           ${availabilityState} AS state_group,
           a.time_span AS seconds
    FROM oee_availability a
    WHERE ${availabilityExpressions.dateRangePredicate}
      AND ${availabilityExpressions.lotPredicate}
  )
  SELECT day, kind,
         SUM(CASE WHEN state_group='Machine_Running' THEN seconds ELSE 0 END) AS running_seconds
  FROM classified
  WHERE kind IN ('MT','ST')
  GROUP BY day, kind
  ORDER BY day, kind`);
  const dutRows = queryRows(database, `WITH classified AS (
    SELECT substr(d.date,1,10) AS day,
           ${dutExpressions.kindExpression} AS kind,
           CAST(NULLIF(TRIM(d.in_qty),'') AS REAL) AS input_quantity,
           CAST(NULLIF(TRIM(d.out_qty),'') AS REAL) AS output_quantity,
           CAST(NULLIF(TRIM(d.dut_num),'') AS REAL) AS dut_count
    FROM oee_dut_utilization d
    WHERE ${dutExpressions.dateRangePredicate}
      AND ${dutExpressions.lotPredicate}
  )
  SELECT day, kind,
         SUM(input_quantity) AS input_quantity,
         SUM(output_quantity) AS output_quantity,
         SUM(dut_count) AS dut_count
  FROM classified
  WHERE kind IN ('MT','ST')
  GROUP BY day, kind
  ORDER BY day, kind`);
  const coverageRows = queryRows(database, `WITH coverage AS (
    SELECT substr(date,1,10) AS day, COUNT(*) AS availability_rows, 0 AS dut_rows
    FROM oee_availability
    WHERE substr(date,1,10)>='${start}' AND substr(date,1,10)<'${shiftDate(end, 1)}'
    GROUP BY substr(date,1,10)
    UNION ALL
    SELECT substr(date,1,10) AS day, 0 AS availability_rows, COUNT(*) AS dut_rows
    FROM oee_dut_utilization
    WHERE substr(date,1,10)>='${start}' AND substr(date,1,10)<'${shiftDate(end, 1)}'
    GROUP BY substr(date,1,10)
  )
  SELECT day, SUM(availability_rows) AS availability_rows, SUM(dut_rows) AS dut_rows
  FROM coverage GROUP BY day ORDER BY day`);
  const topRows = queryRows(database, `WITH classified AS (
    SELECT a.tool_name AS machine,
           ${availabilityExpressions.kindExpression} AS kind,
           ${availabilityState} AS state_group,
           a.time_span AS seconds
    FROM oee_availability a
    WHERE ${availabilityExpressions.dateRangePredicate}
      AND ${availabilityExpressions.lotPredicate}
  )
  SELECT machine, kind,
         100.0 * SUM(CASE WHEN state_group='Machine_Running' THEN seconds ELSE 0 END) /
           (14 * 86400) AS availability
  FROM classified
  WHERE kind IN ('MT','ST')
  GROUP BY machine, kind
  ORDER BY availability DESC
  LIMIT 10`);

  const machineByKind = rowsByKey(machineRows, "kind");
  const availabilityByDayKind = rowsByKey(
    availabilityRows.map((row) => ({ ...row, key: `${String(row["day"])}:${String(row["kind"])}` })),
    "key",
  );
  const dutByDayKind = rowsByKey(
    dutRows.map((row) => ({ ...row, key: `${String(row["day"])}:${String(row["kind"])}` })),
    "key",
  );
  const coverageByDate = rowsByKey(coverageRows, "day");
  const availabilityCoverage = new Map<string, DashboardRow>();
  const dutCoverage = new Map<string, DashboardRow>();
  for (const [date, row] of coverageByDate) {
    if ((numeric(row["availability_rows"]) ?? 0) > 0) {
      availabilityCoverage.set(date, { row_count: row["availability_rows"] ?? null });
    }
    if ((numeric(row["dut_rows"]) ?? 0) > 0) {
      dutCoverage.set(date, { row_count: row["dut_rows"] ?? null });
    }
  }
  const warnings = missingWarnings(dates, availabilityCoverage, dutCoverage);
  if (!validDate(availabilityEnd)) warnings.push("Availability 数据为空");
  if (!validDate(dutEnd)) warnings.push("DUT 数据为空");

  const totalsByKind = new Map<string, OeeParts>();
  const trendRows: DashboardRow[] = dates.map((date) => {
    const output: Record<string, string | number | null> = { date };
    for (const kind of ["MT", "ST"] as const) {
      const availabilityDay = availabilityByDayKind.get(`${date}:${kind}`);
      const dutDay = dutByDayKind.get(`${date}:${kind}`);
      const parts = oeeParts(
        numeric(availabilityDay?.["running_seconds"]),
        numeric(machineByKind.get(kind)?.["machine_count"]),
        1,
        numeric(dutDay?.["input_quantity"]),
        numeric(dutDay?.["output_quantity"]),
        numeric(dutDay?.["dut_count"]),
      );
      output[kind.toLowerCase()] = percent(parts.oee);
    }
    return output;
  });
  for (const kind of ["MT", "ST"] as const) {
    let running = 0;
    let input = 0;
    let output = 0;
    let dut = 0;
    let hasAvailability = false;
    let hasDut = false;
    for (const date of dates) {
      const availabilityDay = availabilityByDayKind.get(`${date}:${kind}`);
      const dutDay = dutByDayKind.get(`${date}:${kind}`);
      const runningValue = numeric(availabilityDay?.["running_seconds"]);
      if (runningValue !== null) {
        running += runningValue;
        hasAvailability = true;
      }
      const inputValue = numeric(dutDay?.["input_quantity"]);
      const outputValue = numeric(dutDay?.["output_quantity"]);
      const dutValue = numeric(dutDay?.["dut_count"]);
      if (inputValue !== null || outputValue !== null || dutValue !== null) hasDut = true;
      input += inputValue ?? 0;
      output += outputValue ?? 0;
      dut += dutValue ?? 0;
    }
    totalsByKind.set(kind, oeeParts(
      hasAvailability ? running : null,
      numeric(machineByKind.get(kind)?.["machine_count"]),
      14,
      hasDut ? input : null,
      hasDut ? output : null,
      hasDut ? dut : null,
    ));
  }
  const componentRows: DashboardRow[] = (["MT", "ST"] as const).map((kind) => {
    const parts = totalsByKind.get(kind);
    return {
      kind,
      availability: percent(parts?.availability ?? null),
      dut_on: percent(parts?.dutOn ?? null),
      yield: percent(parts?.yield ?? null),
    };
  });
  const coverageData: DashboardRow[] = dates.map((date) => ({
    date,
    availability_rows: numeric(coverageByDate.get(date)?.["availability_rows"]) ?? 0,
    dut_rows: numeric(coverageByDate.get(date)?.["dut_rows"]) ?? 0,
  }));
  const kpi = (kind: "MT" | "ST"): DashboardWidget => {
    const parts = totalsByKind.get(kind) ?? oeeParts(null, null, 14, null, null, null);
    return {
      id: `${kind.toLowerCase()}-test-oee`,
      kind: "kpi",
      title: `${kind} Test OEE`,
      subtitle: formatPartsSubtitle(parts),
      size: "small",
      data: [{ value: percent(parts.oee) }],
      encoding: { value: "value", comparison: null },
      format: { unit: "%", precision: 2 },
      metricDefinition: "Test OEE = Availability × DUT-On × 1 × Yield",
      warnings,
    };
  };
  return parseDashboardState({
    schemaVersion: DASHBOARD_SCHEMA_VERSION,
    revision: 0,
    dataAsOf: new Date().toISOString(),
    dateRange: { start, end },
    widgets: [
      kpi("MT"),
      kpi("ST"),
      {
        id: "oee-components",
        kind: "bar",
        title: "OEE 组成项",
        subtitle: `${start} 至 ${end} · MT / ST`,
        size: "medium",
        data: componentRows,
        encoding: {
          category: "kind",
          series: [
            { name: "Availability", column: "availability" },
            { name: "DUT-On", column: "dut_on" },
            { name: "Yield", column: "yield" },
          ],
          orientation: "vertical",
        },
        format: { unit: "%", precision: 1 },
        metricDefinition: "三个组成项按 MT/ST 分别聚合；Performance 固定为 1",
        warnings,
      },
      {
        id: "oee-trend-14d",
        kind: "line",
        title: "Test OEE 日趋势",
        subtitle: `${start} 至 ${end}`,
        size: "wide",
        data: trendRows,
        encoding: {
          category: "date",
          series: [{ name: "MT", column: "mt" }, { name: "ST", column: "st" }],
        },
        format: { unit: "%", precision: 1 },
        metricDefinition: "按自然日分别计算 MT/ST Test OEE",
        warnings,
      },
      {
        id: "availability-top10",
        kind: "bar",
        title: "机台 Availability Top 10",
        subtitle: `${start} 至 ${end} · Machine_Running`,
        size: "medium",
        data: topRows,
        encoding: {
          category: "machine",
          series: [{ name: "Availability", column: "availability" }],
          orientation: "horizontal",
        },
        format: { unit: "%", precision: 1 },
        metricDefinition: "机台 Machine_Running 秒数 / (14 × 86400)",
        warnings: warnings.filter((item) => item.startsWith("Availability")),
      },
      {
        id: "data-coverage",
        kind: "line",
        title: "数据覆盖",
        subtitle: `${start} 至 ${end} · 每日事实记录数`,
        size: "medium",
        data: coverageData,
        encoding: {
          category: "date",
          series: [
            { name: "Availability", column: "availability_rows" },
            { name: "DUT", column: "dut_rows" },
          ],
        },
        format: { unit: " 行", precision: 0 },
        metricDefinition: "两张事实表按日期统计记录数",
        warnings,
      },
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
  if (request.kind === "kpi" && snapshot.rows.length !== 1) {
    throw new DashboardInputError("KPI 图表快照必须恰好包含一行");
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
