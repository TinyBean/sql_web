import type { JsonValue } from "./contracts.ts";

export const DASHBOARD_SCHEMA_VERSION = 1 as const;
export const MAX_DASHBOARD_WIDGETS = 12;
export const MAX_DASHBOARD_ROWS_PER_WIDGET = 2_000;
export const MAX_DASHBOARD_SERIES = 6;
export const MAX_DASHBOARD_TABLE_COLUMNS = 8;
export const MAX_DASHBOARD_FILE_BYTES = 2 * 1024 * 1024;

export type DashboardWidgetKind =
  | "kpi"
  | "line"
  | "bar"
  | "stacked-bar"
  | "donut"
  | "table";

export type DashboardWidgetSize = "small" | "medium" | "wide";
export type DashboardScalar = string | number | null;
export type DashboardRow = Readonly<Record<string, DashboardScalar>>;

export interface DashboardSeriesEncoding {
  readonly name: string;
  readonly column: string;
}

export interface DashboardKpiEncoding {
  readonly value: string;
  readonly comparison: string | null;
}

export interface DashboardLineEncoding {
  readonly category: string;
  readonly series: readonly DashboardSeriesEncoding[];
}

export interface DashboardBarEncoding extends DashboardLineEncoding {
  readonly orientation: "horizontal" | "vertical";
}

export interface DashboardDonutEncoding {
  readonly category: string;
  readonly value: string;
}

export interface DashboardTableColumn {
  readonly key: string;
  readonly label: string;
}

export interface DashboardTableEncoding {
  readonly columns: readonly DashboardTableColumn[];
}

export type DashboardEncoding =
  | DashboardKpiEncoding
  | DashboardLineEncoding
  | DashboardBarEncoding
  | DashboardDonutEncoding
  | DashboardTableEncoding;

interface DashboardWidgetBase {
  readonly id: string;
  readonly title: string;
  readonly subtitle: string;
  readonly size: DashboardWidgetSize;
  readonly data: readonly DashboardRow[];
  readonly format: { readonly unit: string; readonly precision: number };
  readonly metricDefinition: string;
  readonly warnings: readonly string[];
}

export interface DashboardKpiWidget extends DashboardWidgetBase {
  readonly kind: "kpi";
  readonly encoding: DashboardKpiEncoding;
}

export interface DashboardLineWidget extends DashboardWidgetBase {
  readonly kind: "line";
  readonly encoding: DashboardLineEncoding;
}

export interface DashboardBarWidget extends DashboardWidgetBase {
  readonly kind: "bar" | "stacked-bar";
  readonly encoding: DashboardBarEncoding;
}

export interface DashboardDonutWidget extends DashboardWidgetBase {
  readonly kind: "donut";
  readonly encoding: DashboardDonutEncoding;
}

export interface DashboardTableWidget extends DashboardWidgetBase {
  readonly kind: "table";
  readonly encoding: DashboardTableEncoding;
}

export type DashboardWidget =
  | DashboardKpiWidget
  | DashboardLineWidget
  | DashboardBarWidget
  | DashboardDonutWidget
  | DashboardTableWidget;

export interface DashboardState {
  readonly schemaVersion: typeof DASHBOARD_SCHEMA_VERSION;
  readonly revision: number;
  readonly dataAsOf: string;
  readonly dateRange: { readonly start: string | null; readonly end: string | null };
  readonly widgets: readonly DashboardWidget[];
}

export class DashboardValidationError extends Error {
  readonly path: string;

  constructor(path: string, expected: string) {
    super(`${path} 应为${expected}`);
    this.name = "DashboardValidationError";
    this.path = path;
  }
}

function invalid(path: string, expected: string): never {
  throw new DashboardValidationError(path, expected);
}

function record(value: unknown, path: string): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : invalid(path, "对象");
}

function string(value: unknown, path: string, maximum = 500): string {
  if (typeof value !== "string" || value.length > maximum) return invalid(path, `不超过 ${maximum} 字符的字符串`);
  return value;
}

function nonEmptyString(value: unknown, path: string, maximum = 120): string {
  const decoded = string(value, path, maximum);
  return decoded.trim() ? decoded : invalid(path, "非空字符串");
}

function integer(value: unknown, path: string, minimum: number, maximum: number): number {
  return typeof value === "number" && Number.isInteger(value) && value >= minimum && value <= maximum
    ? value
    : invalid(path, `${minimum} 到 ${maximum} 的整数`);
}

function nullableString(value: unknown, path: string): string | null {
  return value === null ? null : string(value, path, 32);
}

function nullableDate(value: unknown, path: string): string | null {
  const decoded = nullableString(value, path);
  if (decoded === null) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(decoded)) return invalid(path, "YYYY-MM-DD 日期或 null");
  const parsed = new Date(`${decoded}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === decoded
    ? decoded
    : invalid(path, "有效 YYYY-MM-DD 日期或 null");
}

function array<Value>(
  value: unknown,
  path: string,
  decode: (item: unknown, itemPath: string) => Value,
  maximum: number,
): Value[] {
  if (!Array.isArray(value) || value.length > maximum) return invalid(path, `最多 ${maximum} 项的数组`);
  return value.map((item, index) => decode(item, `${path}[${index}]`));
}

function widgetKind(value: unknown, path: string): DashboardWidgetKind {
  return value === "kpi" || value === "line" || value === "bar" || value === "stacked-bar" ||
      value === "donut" || value === "table"
    ? value
    : invalid(path, "合法图表类型");
}

function widgetSize(value: unknown, path: string): DashboardWidgetSize {
  return value === "small" || value === "medium" || value === "wide"
    ? value
    : invalid(path, "small、medium 或 wide");
}

function row(value: unknown, path: string): DashboardRow {
  const source = record(value, path);
  const decoded: Record<string, DashboardScalar> = {};
  for (const [key, item] of Object.entries(source)) {
    if (item !== null && typeof item !== "string" && (typeof item !== "number" || !Number.isFinite(item))) {
      invalid(`${path}.${key}`, "字符串、有限数字或 null");
    }
    decoded[key] = item as DashboardScalar;
  }
  return decoded;
}

function series(value: unknown, path: string): DashboardSeriesEncoding[] {
  const decoded = array(value, path, (item, itemPath) => {
    const source = record(item, itemPath);
    return {
      name: nonEmptyString(source["name"], `${itemPath}.name`, 80),
      column: nonEmptyString(source["column"], `${itemPath}.column`, 80),
    };
  }, MAX_DASHBOARD_SERIES);
  return decoded.length ? decoded : invalid(path, "至少一项的序列数组");
}

function encoding(kind: DashboardWidgetKind, value: unknown, path: string): DashboardEncoding {
  const source = record(value, path);
  if (kind === "kpi") {
    return {
      value: nonEmptyString(source["value"], `${path}.value`, 80),
      comparison: source["comparison"] === undefined
        ? null
        : nullableString(source["comparison"], `${path}.comparison`),
    };
  }
  if (kind === "line") {
    return {
      category: nonEmptyString(source["category"], `${path}.category`, 80),
      series: series(source["series"], `${path}.series`),
    };
  }
  if (kind === "bar" || kind === "stacked-bar") {
    const orientation = source["orientation"];
    if (orientation !== "horizontal" && orientation !== "vertical") {
      invalid(`${path}.orientation`, "horizontal 或 vertical");
    }
    return {
      category: nonEmptyString(source["category"], `${path}.category`, 80),
      series: series(source["series"], `${path}.series`),
      orientation,
    };
  }
  if (kind === "donut") {
    return {
      category: nonEmptyString(source["category"], `${path}.category`, 80),
      value: nonEmptyString(source["value"], `${path}.value`, 80),
    };
  }
  const columns = array(source["columns"], `${path}.columns`, (item, itemPath) => {
    const column = record(item, itemPath);
    return {
      key: nonEmptyString(column["key"], `${itemPath}.key`, 80),
      label: nonEmptyString(column["label"], `${itemPath}.label`, 80),
    };
  }, MAX_DASHBOARD_TABLE_COLUMNS);
  if (!columns.length) invalid(`${path}.columns`, "至少一项的列数组");
  return { columns };
}

function widget(value: unknown, path: string): DashboardWidget {
  const source = record(value, path);
  const kind = widgetKind(source["kind"], `${path}.kind`);
  const format = record(source["format"], `${path}.format`);
  const common = {
    id: nonEmptyString(source["id"], `${path}.id`, 64),
    kind,
    title: nonEmptyString(source["title"], `${path}.title`, 120),
    subtitle: string(source["subtitle"], `${path}.subtitle`, 240),
    size: widgetSize(source["size"], `${path}.size`),
    data: array(source["data"], `${path}.data`, row, MAX_DASHBOARD_ROWS_PER_WIDGET),
    encoding: encoding(kind, source["encoding"], `${path}.encoding`),
    format: {
      unit: string(format["unit"], `${path}.format.unit`, 24),
      precision: integer(format["precision"], `${path}.format.precision`, 0, 8),
    },
    metricDefinition: nonEmptyString(
      source["metricDefinition"],
      `${path}.metricDefinition`,
      1_000,
    ),
    warnings: array(
      source["warnings"],
      `${path}.warnings`,
      (item, itemPath) => nonEmptyString(item, itemPath, 300),
      20,
    ),
  };
  return common as DashboardWidget;
}

export function parseDashboardState(value: unknown, path = "$dashboard"): DashboardState {
  const source = record(value, path);
  if (source["schemaVersion"] !== DASHBOARD_SCHEMA_VERSION) {
    invalid(`${path}.schemaVersion`, String(DASHBOARD_SCHEMA_VERSION));
  }
  const widgets = array(source["widgets"], `${path}.widgets`, widget, MAX_DASHBOARD_WIDGETS);
  const ids = new Set<string>();
  for (const [index, item] of widgets.entries()) {
    if (!/^[a-z][a-z0-9-]{0,63}$/u.test(item.id)) {
      invalid(`${path}.widgets[${index}].id`, "小写语义组件 ID");
    }
    if (ids.has(item.id)) invalid(`${path}.widgets[${index}].id`, "唯一组件 ID");
    ids.add(item.id);
  }
  const dateRange = record(source["dateRange"], `${path}.dateRange`);
  const start = nullableDate(dateRange["start"], `${path}.dateRange.start`);
  const end = nullableDate(dateRange["end"], `${path}.dateRange.end`);
  if (start !== null && end !== null && start > end) {
    invalid(`${path}.dateRange`, "开始日期不晚于结束日期");
  }
  const dataAsOf = nonEmptyString(source["dataAsOf"], `${path}.dataAsOf`, 64);
  if (Number.isNaN(Date.parse(dataAsOf))) invalid(`${path}.dataAsOf`, "ISO 日期时间");
  return {
    schemaVersion: DASHBOARD_SCHEMA_VERSION,
    revision: integer(source["revision"], `${path}.revision`, 0, Number.MAX_SAFE_INTEGER),
    dataAsOf,
    dateRange: {
      start,
      end,
    },
    widgets,
  };
}

export function dashboardStateAsJsonValue(state: DashboardState): JsonValue {
  return JSON.parse(JSON.stringify(state)) as JsonValue;
}
