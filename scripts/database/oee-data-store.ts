import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream, existsSync } from "node:fs";
import { mkdir, readFile, stat, unlink } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";
import { DatabaseSync } from "node:sqlite";
import type { AppLogger } from "../../src/server/logger.ts";

export const OEE_DATASETS = ["availability", "dut_utilization"] as const;
export type OeeDataset = (typeof OEE_DATASETS)[number];

type JsonRecord = Record<string, unknown>;
type SourceKind = "file" | "api";

interface DatasetSpec {
  readonly dataset: OeeDataset;
  readonly endpointName: string;
  readonly resultKey: string;
  readonly rowKey: string;
  readonly tableName: "oee_availability" | "oee_dut_utilization";
  readonly dataDateExpression: string;
  readonly responseDateOffsetDays: number;
}

export interface DateWindow {
  readonly startDate: string;
  readonly endDate: string;
}

export type ImportOutcome = "completed" | "completed_with_warnings";
export type RunOutcome = ImportOutcome | "failed";

export function outcomeExitCode(status: ImportOutcome | RunOutcome): 0 | 1 | 2 {
  if (status === "failed") return 1;
  if (status === "completed_with_warnings") return 2;
  return 0;
}

export interface OeeDataStoreOptions {
  readonly databasePath: string;
  readonly apiBaseUrl?: string;
  readonly apiUsername?: string;
  readonly apiPassword?: string;
  readonly requestTimeoutMs?: number;
  readonly fetchRetries?: number;
  readonly logger?: AppLogger;
}

interface ResolvedOeeDataStoreOptions {
  readonly databasePath: string;
  readonly apiBaseUrl: string;
  readonly authorizationHeader?: string;
  readonly requestTimeoutMs: number;
  readonly fetchRetries: number;
  readonly logger: AppLogger;
}

export interface ImportFileOptions {
  readonly dataset: OeeDataset;
  readonly filePath: string;
  readonly requestedStartDate: string;
  readonly requestedEndDate: string;
  readonly sourceKind?: SourceKind;
  readonly sourceRef?: string;
}

export interface PullWindowOptions {
  readonly dataset: OeeDataset;
  readonly startDate: string;
  readonly endDate: string;
}

export interface SyncOptions {
  readonly dataset?: OeeDataset | "all";
  readonly throughDate: string;
  readonly initialStartDate?: string;
  readonly overlapDays?: number;
  readonly maxWindowDays?: number;
}

export interface DatabaseCoverage {
  readonly minDataDate: string | null;
  readonly maxDataDate: string | null;
  readonly rowCount: number;
  readonly distinctDateCount: number;
}

export interface ImportResult {
  readonly runId: string;
  readonly windowId: string;
  readonly status: ImportOutcome;
  readonly dataset: OeeDataset;
  readonly requestedStartDate: string;
  readonly requestedEndDate: string;
  readonly expectedStartDate: string;
  readonly expectedEndDate: string;
  readonly rowsReceived: number;
  readonly rowsInserted: number;
  readonly rowsDeleted: number;
  readonly unscopedRowCount: number;
  readonly observedMinDate: string | null;
  readonly observedMaxDate: string | null;
  readonly observedDayCounts: Readonly<Record<string, number>>;
  readonly missingDates: readonly string[];
  readonly unexpectedDates: readonly string[];
  readonly sourceSha256: string;
  readonly coverage: DatabaseCoverage;
}

export interface FailedWindowResult {
  readonly runId: string;
  readonly windowId: string;
  readonly status: "failed";
  readonly dataset: OeeDataset;
  readonly requestedStartDate: string;
  readonly requestedEndDate: string;
  readonly errorStage: string;
  readonly errorMessage: string;
}

export type ImportWindowResult = ImportResult | FailedWindowResult;

export interface DateRange {
  readonly startDate: string;
  readonly endDate: string;
}

export interface DatasetFacts extends DatabaseCoverage {
  readonly missingDateRanges: readonly DateRange[];
  readonly unscopedRowCount: number;
}

export interface ImportIssue {
  readonly windowId: string;
  readonly status: "completed_with_warnings" | "failed" | "interrupted";
  readonly requestedStartDate: string;
  readonly requestedEndDate: string;
  readonly missingDates: readonly string[];
  readonly unexpectedDates: readonly string[];
  readonly unscopedRowCount: number;
  readonly errorStage: string | null;
  readonly errorMessage: string | null;
}

export interface ImportRecommendation extends DateRange {
  readonly action: "sync" | "reimport";
  readonly reason: string;
  readonly windowIds: readonly string[];
}

export interface DatasetStatus {
  readonly dataset: OeeDataset;
  readonly apiEndpoint: string;
  readonly facts: DatasetFacts;
  readonly tracking: {
    readonly state: "empty" | "legacy_untracked" | "partially_tracked" | "tracked";
    readonly trackedStartDate: string | null;
    readonly trackedEndDate: string | null;
    readonly completedThroughDate: string | null;
    readonly nextStartDate: string | null;
    readonly unresolvedRanges: readonly DateRange[];
    readonly latestRun: {
      readonly runId: string;
      readonly command: string;
      readonly status: string;
      readonly startedAt: string;
      readonly completedAt: string | null;
      readonly errorStage: string | null;
      readonly errorMessage: string | null;
    } | null;
  };
  readonly issues: readonly ImportIssue[];
  readonly recommendations: readonly ImportRecommendation[];
}

export interface SyncResult {
  readonly runId: string;
  readonly status: RunOutcome;
  readonly datasets: readonly DatasetSyncResult[];
}

export interface DatasetSyncResult {
  readonly dataset: OeeDataset;
  readonly plannedWindows: readonly DateWindow[];
  readonly imports: readonly ImportWindowResult[];
  readonly planningError?: {
    readonly stage: "planning";
    readonly message: string;
  };
}

interface AvailabilityRow {
  readonly dataDate: string;
  readonly toolName: string;
  readonly lotId: string;
  readonly finalState: string;
  readonly step: string;
  readonly date: string;
  readonly shift: string | null;
  readonly timeSpan: number;
}

interface DutRow {
  readonly dataDate: string | null;
  readonly machineId: string;
  readonly lotId: string;
  readonly touchdownIndex: string | null;
  readonly startTime: string | null;
  readonly endTime: string | null;
  readonly inQty: string;
  readonly outQty: string;
  readonly totalIn: string | null;
  readonly totalOut: string | null;
  readonly partNum: string | null;
  readonly packageSize: string | null;
  readonly testStage: string;
  readonly testProgram: string | null;
  readonly stepCode: string | null;
  readonly tooling: string | null;
  readonly testerDutOff: string | null;
  readonly handlerDutOff: string | null;
  readonly dutNum: string;
  readonly flushFlag: string | null;
  readonly mixNomix: string | null;
  readonly hbinInfo: string | null;
  readonly dutLotMap: string | null;
  readonly tdSeqForspc: number | null;
  readonly fullTdIndex: number | null;
  readonly sbinSocketOff: string | null;
  readonly tdSocketOff: string | null;
  readonly stepId: string;
  readonly trayId: string | null;
  readonly sbinSocketOffCount: number | null;
  readonly testerDutOffCount: number | null;
  readonly tdSocketOffCount: number | null;
  readonly handlerDutOffCount: number | null;
  readonly partialTd: number | null;
  readonly dutOffAuto: number | null;
  readonly dutOffManual: number | null;
  readonly date: string | null;
  readonly shift: string | null;
}

const DEFAULT_API_BASE_URL = "http://csj-mp-dvapp03.wdc.com:9400/json/Interface/ORPTSIP/";
const DEFAULT_REQUEST_TIMEOUT_MS = 15 * 60 * 1_000;
const DEFAULT_FETCH_RETRIES = 2;
const MAX_API_WINDOW_DAYS = 3;
const MAX_DATE_RANGE_DAYS = 3_660;
const MAX_EMPTY_RESPONSE_BYTES = 64 * 1_024;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/u;
const SILENT_LOGGER: AppLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => SILENT_LOGGER,
};

const DATASET_SPECS: Record<OeeDataset, DatasetSpec> = {
  availability: {
    dataset: "availability",
    endpointName: "R_OEE_MT_TOP_AVAILABILITY_2W",
    resultKey: "ORPTSIP.R_OEE_MT_TOP_AVAILABILITY_2WResult",
    rowKey: "ORPTSIP.row",
    tableName: "oee_availability",
    dataDateExpression: "substr(date, 1, 10)",
    responseDateOffsetDays: 0,
  },
  dut_utilization: {
    dataset: "dut_utilization",
    endpointName: "R_OEE_MT_TOP_DUT_UTILIZATION_2W",
    resultKey: "ORPTSIP.R_OEE_MT_TOP_DUT_UTILIZATION_2WResult",
    rowKey: "ORPTSIP.row",
    tableName: "oee_dut_utilization",
    dataDateExpression: "substr(date, 1, 10)",
    responseDateOffsetDays: -1,
  },
};

class RowArrayExtractor {
  readonly #marker: string;
  #phase: "seek-key" | "seek-array" | "seek-value" | "capture" | "done" = "seek-key";
  #window = "";
  #sawColon = false;
  #record = "";
  #depth = 0;
  #inString = false;
  #escaped = false;

  constructor(rowKey: string) {
    this.#marker = JSON.stringify(rowKey);
  }

  *push(text: string): Generator<JsonRecord> {
    for (const char of text) {
      if (this.#phase === "done") continue;

      if (this.#phase === "seek-key") {
        this.#window = (this.#window + char).slice(-this.#marker.length);
        if (this.#window === this.#marker) this.#phase = "seek-array";
        continue;
      }

      if (this.#phase === "seek-array") {
        if (/\s/u.test(char)) continue;
        if (!this.#sawColon && char === ":") {
          this.#sawColon = true;
          continue;
        }
        if (this.#sawColon && char === "[") {
          this.#phase = "seek-value";
          continue;
        }
        throw new Error(`字段 ${this.#marker} 后不是 JSON 数组`);
      }

      if (this.#phase === "seek-value") {
        if (/\s/u.test(char) || char === ",") continue;
        if (char === "]") {
          this.#phase = "done";
          continue;
        }
        if (char !== "{") throw new Error(`${this.#marker} 数组中存在非对象元素`);
        this.#phase = "capture";
        this.#record = "{";
        this.#depth = 1;
        this.#inString = false;
        this.#escaped = false;
        continue;
      }

      this.#record += char;
      if (this.#inString) {
        if (this.#escaped) this.#escaped = false;
        else if (char === "\\") this.#escaped = true;
        else if (char === "\"") this.#inString = false;
        continue;
      }
      if (char === "\"") {
        this.#inString = true;
        continue;
      }
      if (char === "{" || char === "[") this.#depth += 1;
      else if (char === "}" || char === "]") this.#depth -= 1;
      if (this.#depth !== 0) continue;

      const value: unknown = JSON.parse(this.#record);
      if (typeof value !== "object" || value === null || Array.isArray(value)) {
        throw new Error(`${this.#marker} 数组中存在非对象元素`);
      }
      this.#record = "";
      this.#phase = "seek-value";
      yield value as JsonRecord;
    }
  }

  finish(): void {
    if (this.#phase !== "done") {
      throw new Error(`JSON 响应不完整,未能完整读取 ${this.#marker} 数组`);
    }
  }
}

class NonRetryableDownloadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NonRetryableDownloadError";
  }
}

function isDataset(value: string): value is OeeDataset {
  return OEE_DATASETS.some((dataset) => dataset === value);
}

export function parseOeeDataset(value: string): OeeDataset {
  if (!isDataset(value)) {
    throw new Error(`未知数据集 ${value};可用值为 ${OEE_DATASETS.join(", ")}`);
  }
  return value;
}

function dateFromKey(value: string, fieldName: string): Date {
  if (!DATE_PATTERN.test(value)) throw new Error(`${fieldName} 必须使用 YYYY-MM-DD 格式`);
  const date = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value) {
    throw new Error(`${fieldName} 不是有效日期:${value}`);
  }
  return date;
}

function normalizeDateKey(value: string, fieldName: string): string {
  dateFromKey(value, fieldName);
  return value;
}

function addDays(value: string, days: number): string {
  const date = dateFromKey(value, "date");
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function dateRange(startDate: string, endDate: string): string[] {
  const start = dateFromKey(startDate, "requestedStartDate");
  const end = dateFromKey(endDate, "requestedEndDate");
  if (start > end) throw new Error(`开始日期 ${startDate} 不能晚于结束日期 ${endDate}`);
  const days = Math.floor((end.getTime() - start.getTime()) / 86_400_000) + 1;
  if (days > MAX_DATE_RANGE_DAYS) throw new Error(`单次日期范围不能超过 ${MAX_DATE_RANGE_DAYS} 天`);
  return Array.from({ length: days }, (_, index) => addDays(startDate, index));
}

function compactDate(value: string): string {
  return value.replaceAll("-", "");
}

function timestampSeconds(value: string, fieldName: string): number {
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) throw new Error(`${fieldName} 不是有效时间:${value}`);
  return Math.floor(milliseconds / 1_000);
}

function sourceDataDate(value: string, fieldName: string): string {
  if (value.length < 10) throw new Error(`${fieldName} 不是有效时间:${value}`);
  return normalizeDateKey(value.slice(0, 10), fieldName);
}

function requiredString(record: JsonRecord, key: string): string {
  const value = record[key];
  if (typeof value !== "string") throw new Error(`字段 ${key} 必须是字符串`);
  return value;
}

function optionalSourceString(record: JsonRecord, key: string): string | null {
  const value = record[key];
  if (value === undefined || value === null) return null;
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value) ?? String(value);
}

function requiredInteger(record: JsonRecord, key: string): number {
  const value = record[key];
  const number = typeof value === "number"
    ? value
    : typeof value === "string" && value.trim() !== ""
      ? Number(value)
      : Number.NaN;
  if (!Number.isSafeInteger(number)) throw new Error(`字段 ${key} 必须是安全整数,当前值为 ${String(value)}`);
  return number;
}

function optionalInteger(record: JsonRecord, key: string): number | null {
  const value = record[key];
  if (value === undefined || value === null) return null;
  const number = typeof value === "number"
    ? value
    : typeof value === "string" && value.trim() !== ""
      ? Number(value)
      : Number.NaN;
  return Number.isSafeInteger(number) ? number : null;
}

function optionalDataDate(value: string | null): string | null {
  if (!value || value.length < 10) return null;
  try {
    return normalizeDateKey(value.slice(0, 10), "ORPTSIP.DATE");
  } catch {
    return null;
  }
}

function normalizeAvailability(record: JsonRecord): AvailabilityRow {
  const date = requiredString(record, "ORPTSIP.DATE");
  const dataDate = sourceDataDate(date, "ORPTSIP.DATE");
  timestampSeconds(date, "ORPTSIP.DATE");
  const toolName = requiredString(record, "ORPTSIP.TOOL_NAME");
  const lotId = requiredString(record, "ORPTSIP.LOT_ID");
  const finalState = requiredString(record, "ORPTSIP.FINAL_STATE");
  const step = requiredString(record, "ORPTSIP.STEP");
  const shift = optionalSourceString(record, "ORPTSIP.SHIFT");
  const timeSpan = requiredInteger(record, "ORPTSIP.TIME_SPAN");
  return {
    dataDate,
    toolName,
    lotId,
    finalState,
    step,
    date,
    shift,
    timeSpan,
  };
}

function normalizeDut(record: JsonRecord): DutRow {
  const date = optionalSourceString(record, "ORPTSIP.DATE");
  return {
    dataDate: optionalDataDate(date),
    machineId: requiredString(record, "ORPTSIP.MACHINE_ID"),
    lotId: requiredString(record, "ORPTSIP.LOT_ID"),
    touchdownIndex: optionalSourceString(record, "ORPTSIP.TOUCHDOWN_INDEX"),
    startTime: optionalSourceString(record, "ORPTSIP.START_TIME"),
    endTime: optionalSourceString(record, "ORPTSIP.END_TIME"),
    inQty: requiredString(record, "ORPTSIP.IN_QTY"),
    outQty: requiredString(record, "ORPTSIP.OUT_QTY"),
    totalIn: optionalSourceString(record, "ORPTSIP.TOTAL_IN"),
    totalOut: optionalSourceString(record, "ORPTSIP.TOTAL_OUT"),
    partNum: optionalSourceString(record, "ORPTSIP.PART_NUM"),
    packageSize: optionalSourceString(record, "ORPTSIP.PACKAGE_SIZE"),
    testStage: requiredString(record, "ORPTSIP.TEST_STAGE"),
    testProgram: optionalSourceString(record, "ORPTSIP.TEST_PROGRAM"),
    stepCode: optionalSourceString(record, "ORPTSIP.STEP_CODE"),
    tooling: optionalSourceString(record, "ORPTSIP.TOOLING"),
    testerDutOff: optionalSourceString(record, "ORPTSIP.TESTER_DUT_OFF"),
    handlerDutOff: optionalSourceString(record, "ORPTSIP.HANDLER_DUT_OFF"),
    dutNum: requiredString(record, "ORPTSIP.DUT_NUM"),
    flushFlag: optionalSourceString(record, "ORPTSIP.FLUSH_FLAG"),
    mixNomix: optionalSourceString(record, "ORPTSIP.MIX_NOMIX"),
    hbinInfo: optionalSourceString(record, "ORPTSIP.HBIN_INFO"),
    dutLotMap: optionalSourceString(record, "ORPTSIP.DUT_LOT_MAP"),
    tdSeqForspc: optionalInteger(record, "ORPTSIP.TD_SEQ_FORSPC"),
    fullTdIndex: optionalInteger(record, "ORPTSIP.FULL_TD_INDEX"),
    sbinSocketOff: optionalSourceString(record, "ORPTSIP.SBIN_SOCKET_OFF"),
    tdSocketOff: optionalSourceString(record, "ORPTSIP.TD_SOCKET_OFF"),
    stepId: requiredString(record, "ORPTSIP.STEP_ID"),
    trayId: optionalSourceString(record, "ORPTSIP.TRAY_ID"),
    sbinSocketOffCount: optionalInteger(record, "ORPTSIP.SBIN_SOCKET_OFF_COUNT"),
    testerDutOffCount: optionalInteger(record, "ORPTSIP.TESTER_DUT_OFF_COUNT"),
    tdSocketOffCount: optionalInteger(record, "ORPTSIP.TD_SOCKET_OFF_COUNT"),
    handlerDutOffCount: optionalInteger(record, "ORPTSIP.HANDLER_DUT_OFF_COUNT"),
    partialTd: optionalInteger(record, "ORPTSIP.PARTIAL_TD"),
    dutOffAuto: optionalInteger(record, "ORPTSIP.DUT_OFF_AUTO"),
    dutOffManual: optionalInteger(record, "ORPTSIP.DUT_OFF_MANUAL"),
    date,
    shift: optionalSourceString(record, "ORPTSIP.SHIFT"),
  };
}

async function* streamRecords(
  filePath: string,
  rowKey: string,
  resultKey: string,
  sourceHash: ReturnType<typeof createHash>,
): AsyncGenerator<JsonRecord> {
  const extractor = new RowArrayExtractor(rowKey);
  const decoder = new TextDecoder();
  for await (const chunk of createReadStream(filePath)) {
    const bytes = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
    sourceHash.update(bytes);
    const text = decoder.decode(bytes, { stream: true });
    for (const record of extractor.push(text)) yield record;
  }
  const tail = decoder.decode();
  for (const record of extractor.push(tail)) yield record;
  try {
    extractor.finish();
  } catch (error) {
    if (await hasEmptyDatasetResult(filePath, resultKey)) return;
    throw error;
  }
}

async function hasEmptyDatasetResult(filePath: string, resultKey: string): Promise<boolean> {
  const fileStat = await stat(filePath);
  if (fileStat.size > MAX_EMPTY_RESPONSE_BYTES) return false;
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(filePath, "utf8"));
  } catch {
    return false;
  }
  const pending: unknown[] = [parsed];
  while (pending.length > 0) {
    const value = pending.pop();
    if (typeof value !== "object" || value === null) continue;
    if (Array.isArray(value)) {
      pending.push(...value);
      continue;
    }
    const record = value as Record<string, unknown>;
    const result = record[resultKey];
    if (Object.hasOwn(record, resultKey)) return Array.isArray(result) && result.length === 0;
    pending.push(...Object.values(record));
  }
  return false;
}

function numberColumn(row: Record<string, unknown>, key: string): number {
  const value = row[key];
  if (typeof value === "number") return value;
  if (typeof value === "bigint") return Number(value);
  throw new Error(`SQLite 字段 ${key} 不是数字`);
}

function nullableStringColumn(row: Record<string, unknown>, key: string): string | null {
  const value = row[key];
  if (value === null) return null;
  if (typeof value === "string") return value;
  throw new Error(`SQLite 字段 ${key} 不是字符串或 NULL`);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message.slice(0, 2_000) : String(error).slice(0, 2_000);
}

function endpointUrl(apiBaseUrl: string, spec: DatasetSpec): string {
  const base = apiBaseUrl.endsWith("/") ? apiBaseUrl : `${apiBaseUrl}/`;
  return new URL(spec.endpointName, base).toString();
}

function sourceUrl(apiBaseUrl: string, spec: DatasetSpec, window: DateWindow): string {
  const url = new URL(endpointUrl(apiBaseUrl, spec));
  url.searchParams.set("pSTARTDAY", compactDate(window.startDate));
  url.searchParams.set("pENDDAY", compactDate(window.endDate));
  return url.toString();
}

function retryableStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

async function delay(milliseconds: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}

function mergeAndSplitWindows(windows: readonly DateWindow[], maxWindowDays: number): DateWindow[] {
  const sorted = [...windows].sort((left, right) => left.startDate.localeCompare(right.startDate));
  const merged: DateWindow[] = [];
  for (const window of sorted) {
    const previous = merged.at(-1);
    if (previous && window.startDate <= addDays(previous.endDate, 1)) {
      merged[merged.length - 1] = {
        startDate: previous.startDate,
        endDate: window.endDate > previous.endDate ? window.endDate : previous.endDate,
      };
    } else {
      merged.push(window);
    }
  }

  const split: DateWindow[] = [];
  for (const window of merged) {
    let startDate = window.startDate;
    while (startDate <= window.endDate) {
      const candidateEnd = addDays(startDate, maxWindowDays - 1);
      const endDate = candidateEnd < window.endDate ? candidateEnd : window.endDate;
      split.push({ startDate, endDate });
      startDate = addDays(endDate, 1);
    }
  }
  return split;
}

type WindowState =
  | "planned"
  | "downloading"
  | "importing"
  | "completed"
  | "completed_with_warnings"
  | "failed"
  | "interrupted";

interface RegisteredWindow extends DateWindow {
  readonly id: string;
  readonly runId: string;
  readonly sequence: number;
  readonly dataset: OeeDataset;
  readonly sourceKind: SourceKind;
  readonly sourceRef: string;
  readonly filePath?: string;
}

interface WindowAuditRow {
  readonly id: string;
  readonly status: WindowState;
  readonly requestedStartDate: string;
  readonly requestedEndDate: string;
  readonly missingDates: readonly string[];
  readonly unexpectedDates: readonly string[];
  readonly unscopedRowCount: number;
  readonly errorStage: string | null;
  readonly errorMessage: string | null;
}

const COMPLETED_WINDOW_STATES = new Set<WindowState>([
  "completed",
  "completed_with_warnings",
]);

function operationalTimestamp(now = new Date()): string {
  const shifted = new Date(now.getTime() + 8 * 60 * 60 * 1_000).toISOString();
  return `${shifted.slice(0, -1)}+08:00`;
}

function stringColumn(row: Record<string, unknown>, key: string): string {
  const value = row[key];
  if (typeof value !== "string") throw new Error(`SQLite 字段 ${key} 不是字符串`);
  return value;
}

function jsonStringArray(value: unknown): string[] {
  if (typeof value !== "string") return [];
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

function rowChanges(result: { readonly changes: number | bigint }): number {
  return typeof result.changes === "bigint" ? Number(result.changes) : result.changes;
}

function errorColumns(error: unknown): {
  readonly name: string;
  readonly code: string | null;
  readonly message: string;
} {
  if (!(error instanceof Error)) return { name: "Error", code: null, message: errorMessage(error) };
  const code = "code" in error && (typeof error.code === "string" || typeof error.code === "number")
    ? String(error.code)
    : null;
  return { name: error.name, code, message: errorMessage(error) };
}

function coalesceDates(values: readonly string[]): DateRange[] {
  const dates = [...new Set(values)].sort();
  const ranges: DateRange[] = [];
  for (const date of dates) {
    const previous = ranges.at(-1);
    if (previous && date === addDays(previous.endDate, 1)) {
      ranges[ranges.length - 1] = { startDate: previous.startDate, endDate: date };
    } else {
      ranges.push({ startDate: date, endDate: date });
    }
  }
  return ranges;
}

function expectedWindow(spec: DatasetSpec, window: DateWindow): DateWindow {
  return {
    startDate: addDays(window.startDate, spec.responseDateOffsetDays),
    endDate: addDays(window.endDate, spec.responseDateOffsetDays),
  };
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !(error instanceof Error && "code" in error && error.code === "ESRCH");
  }
}

export class OeeDataStore {
  readonly #database: DatabaseSync;
  readonly #databasePath: string;
  readonly #apiBaseUrl: string;
  readonly #authorizationHeader: string | undefined;
  readonly #requestTimeoutMs: number;
  readonly #fetchRetries: number;
  readonly #logger: AppLogger;
  #closed = false;

  private constructor(options: ResolvedOeeDataStoreOptions, database: DatabaseSync) {
    this.#database = database;
    this.#databasePath = options.databasePath;
    this.#apiBaseUrl = options.apiBaseUrl;
    this.#authorizationHeader = options.authorizationHeader;
    this.#requestTimeoutMs = options.requestTimeoutMs;
    this.#fetchRetries = options.fetchRetries;
    this.#logger = options.logger;
    this.#recoverInterruptedRuns();
  }

  static open(options: OeeDataStoreOptions): OeeDataStore {
    const hasUsername = options.apiUsername !== undefined;
    const hasPassword = options.apiPassword !== undefined;
    if (hasUsername !== hasPassword || options.apiUsername === "" || options.apiPassword === "") {
      throw new Error("API_USER 和 API_PWD 必须同时配置且不能为空");
    }
    const authorizationHeader = hasUsername && hasPassword
      ? `Basic ${Buffer.from(`${options.apiUsername}:${options.apiPassword}`).toString("base64")}`
      : undefined;
    const resolved: ResolvedOeeDataStoreOptions = {
      databasePath: path.resolve(options.databasePath),
      apiBaseUrl: options.apiBaseUrl ?? DEFAULT_API_BASE_URL,
      ...(authorizationHeader ? { authorizationHeader } : {}),
      requestTimeoutMs: options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
      fetchRetries: options.fetchRetries ?? DEFAULT_FETCH_RETRIES,
      logger: options.logger ?? SILENT_LOGGER,
    };
    if (!Number.isInteger(resolved.requestTimeoutMs) || resolved.requestTimeoutMs <= 0) {
      throw new Error("requestTimeoutMs 必须是正整数");
    }
    if (!Number.isInteger(resolved.fetchRetries) || resolved.fetchRetries < 0 || resolved.fetchRetries > 10) {
      throw new Error("fetchRetries 必须是 0 到 10 之间的整数");
    }
    if (!existsSync(resolved.databasePath)) {
      throw new Error(`数据库不存在 ${resolved.databasePath};请先运行 npm run data:init`);
    }
    const database = new DatabaseSync(resolved.databasePath, {
      timeout: 5_000,
      enableForeignKeyConstraints: true,
    });
    try {
      try {
        for (const table of [
          "oee_availability",
          "oee_dut_utilization",
          "oee_import_runs",
          "oee_import_windows",
        ]) database.prepare(`SELECT 1 FROM ${table} LIMIT 0`).all();
      } catch (error) {
        throw new Error(`数据库尚未初始化或需要升级 ${resolved.databasePath};请运行 npm run data:init`, {
          cause: error,
        });
      }
      database.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;");
      return new OeeDataStore(resolved, database);
    } catch (error) {
      database.close();
      throw error;
    }
  }

  async importFile(options: ImportFileOptions): Promise<ImportResult> {
    this.#assertOpen();
    dateRange(options.requestedStartDate, options.requestedEndDate);
    const filePath = path.resolve(options.filePath);
    const sourceKind = options.sourceKind ?? "file";
    const sourceRef = options.sourceRef ?? filePath;
    const runId = this.#createRun("import", {
      dataset: options.dataset,
      filePath,
      requestedStartDate: options.requestedStartDate,
      requestedEndDate: options.requestedEndDate,
    });
    try {
      const window = this.#registerWindow(runId, 0, {
        id: "",
        runId,
        sequence: 0,
        dataset: options.dataset,
        sourceKind,
        sourceRef,
        filePath,
        startDate: options.requestedStartDate,
        endDate: options.requestedEndDate,
      });
      const result = await this.#executeWindow(window);
      this.#finalizeRun(runId);
      return result;
    } catch (error) {
      this.#markRemainingWindowsInterrupted(runId);
      this.#finishSingleRunFailure(runId, error);
      throw error;
    }
  }

  async pullWindow(options: PullWindowOptions): Promise<ImportResult> {
    this.#assertOpen();
    const days = dateRange(options.startDate, options.endDate);
    if (days.length > MAX_API_WINDOW_DAYS) {
      throw new Error(`单次 API 拉取不能超过 ${MAX_API_WINDOW_DAYS} 天`);
    }
    const runId = this.#createRun("pull", options);
    try {
      const spec = DATASET_SPECS[options.dataset];
      const window = this.#registerWindow(runId, 0, {
        id: "",
        runId,
        sequence: 0,
        dataset: options.dataset,
        sourceKind: "api",
        sourceRef: sourceUrl(this.#apiBaseUrl, spec, options),
        startDate: options.startDate,
        endDate: options.endDate,
      });
      const result = await this.#executeWindow(window);
      this.#finalizeRun(runId);
      return result;
    } catch (error) {
      this.#markRemainingWindowsInterrupted(runId);
      this.#finishSingleRunFailure(runId, error);
      throw error;
    }
  }

  async sync(options: SyncOptions): Promise<SyncResult> {
    this.#assertOpen();
    normalizeDateKey(options.throughDate, "throughDate");
    if (options.initialStartDate) normalizeDateKey(options.initialStartDate, "initialStartDate");
    if (options.initialStartDate && options.initialStartDate > options.throughDate) {
      throw new Error(`initialStartDate ${options.initialStartDate} 不能晚于 throughDate ${options.throughDate}`);
    }
    const overlapDays = options.overlapDays ?? 2;
    const maxWindowDays = options.maxWindowDays ?? MAX_API_WINDOW_DAYS;
    if (!Number.isInteger(overlapDays) || overlapDays < 1 || overlapDays > 14) {
      throw new Error("overlapDays 必须是 1 到 14 之间的整数");
    }
    if (!Number.isInteger(maxWindowDays) || maxWindowDays < 1 || maxWindowDays > MAX_API_WINDOW_DAYS) {
      throw new Error(`maxWindowDays 必须是 1 到 ${MAX_API_WINDOW_DAYS} 之间的整数`);
    }
    const datasets = options.dataset && options.dataset !== "all"
      ? [options.dataset]
      : [...OEE_DATASETS];
    return this.#executeMultiWindowRun("sync", datasets, {
      throughDate: options.throughDate,
      initialStartDate: options.initialStartDate,
      overlapDays,
      maxWindowDays,
    }, (dataset) => this.#planSyncWindows(
      dataset,
      options.throughDate,
      options.initialStartDate,
      overlapDays,
      maxWindowDays,
    ));
  }

  async reimport(options: PullWindowOptions): Promise<SyncResult> {
    this.#assertOpen();
    dateRange(options.startDate, options.endDate);
    return this.#executeMultiWindowRun(
      "reimport",
      [options.dataset],
      { startDate: options.startDate, endDate: options.endDate },
      () => mergeAndSplitWindows([options], MAX_API_WINDOW_DAYS),
    );
  }

  getStatus(): DatasetStatus[] {
    this.#assertOpen();
    return OEE_DATASETS.map((dataset) => this.#datasetStatus(dataset));
  }

  close(): void {
    if (this.#closed) return;
    this.#database.close();
    this.#closed = true;
  }

  #assertOpen(): void {
    if (this.#closed) throw new Error("OeeDataStore 已关闭");
  }

  #recoverInterruptedRuns(): void {
    const active = this.#database.prepare(
      "SELECT id, owner_pid FROM oee_import_runs WHERE status = 'running'",
    ).all();
    let interrupted = 0;
    for (const row of active) {
      const ownerPid = numberColumn(row, "owner_pid");
      if (isProcessAlive(ownerPid)) continue;
      const runId = stringColumn(row, "id");
      const now = operationalTimestamp();
      this.#database.prepare(
        `UPDATE oee_import_windows
         SET status = 'interrupted', completed_at = ?, error_stage = 'process',
             error_name = 'InterruptedImport', error_message = '导入进程在窗口完成前退出'
         WHERE run_id = ? AND status IN ('planned', 'downloading', 'importing')`,
      ).run(now, runId);
      this.#database.prepare(
        `UPDATE oee_import_runs
         SET status = 'interrupted', completed_at = ?, error_stage = 'process',
             error_name = 'InterruptedImport', error_message = '导入进程在任务完成前退出'
         WHERE id = ?`,
      ).run(now, runId);
      interrupted += 1;
    }
    if (interrupted > 0) this.#logger.warn("oee.recovery.interrupted", { runCount: interrupted });
  }

  #createRun(command: "import" | "pull" | "sync" | "reimport", parameters: unknown): string {
    const runId = randomUUID();
    let transactionOpen = false;
    try {
      this.#database.exec("BEGIN IMMEDIATE");
      transactionOpen = true;
      const running = this.#database.prepare(
        "SELECT id, owner_pid FROM oee_import_runs WHERE status = 'running' LIMIT 1",
      ).get();
      if (running) {
        throw new Error(
          `已有数据任务正在运行 ${stringColumn(running, "id")} (PID ${numberColumn(running, "owner_pid")})`,
        );
      }
      this.#database.prepare(
        `INSERT INTO oee_import_runs (id, command, parameters_json, status, owner_pid, started_at)
         VALUES (?, ?, ?, 'running', ?, ?)`,
      ).run(runId, command, JSON.stringify(parameters), process.pid, operationalTimestamp());
      this.#database.exec("COMMIT");
      transactionOpen = false;
    } catch (error) {
      if (transactionOpen) this.#database.exec("ROLLBACK");
      throw error;
    }
    this.#logger.child({ importRunId: runId }).info("oee.run.started", { command, parameters });
    return runId;
  }

  #registerWindow(runId: string, sequence: number, window: RegisteredWindow): RegisteredWindow {
    const id = randomUUID();
    const spec = DATASET_SPECS[window.dataset];
    const expected = expectedWindow(spec, window);
    this.#database.prepare(
      `INSERT INTO oee_import_windows (
         id, run_id, sequence, dataset, source_kind, source_ref,
         requested_start_date, requested_end_date, expected_start_date, expected_end_date, status
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'planned')`,
    ).run(
      id,
      runId,
      sequence,
      window.dataset,
      window.sourceKind,
      window.sourceRef,
      window.startDate,
      window.endDate,
      expected.startDate,
      expected.endDate,
    );
    return { ...window, id };
  }

  async #executeMultiWindowRun(
    command: "sync" | "reimport",
    datasets: readonly OeeDataset[],
    parameters: unknown,
    plan: (dataset: OeeDataset) => DateWindow[],
  ): Promise<SyncResult> {
    const runId = this.#createRun(command, { datasets, ...parameters as object });
    const logger = this.#logger.child({ importRunId: runId });
    const datasetResults: DatasetSyncResult[] = [];
    let sequence = 0;
    try {
      const registeredByDataset = new Map<OeeDataset, RegisteredWindow[]>();
      const planningErrors = new Map<OeeDataset, unknown>();
      for (const dataset of datasets) {
        try {
          const windows = plan(dataset);
          logger.info("oee.sync.windows_planned", { dataset, windows });
          const spec = DATASET_SPECS[dataset];
          registeredByDataset.set(dataset, windows.map((window) => this.#registerWindow(
            runId,
            sequence++,
            {
              id: "",
              runId,
              sequence: sequence - 1,
              dataset,
              sourceKind: "api",
              sourceRef: sourceUrl(this.#apiBaseUrl, spec, window),
              ...window,
            },
          )));
        } catch (error) {
          planningErrors.set(dataset, error);
          logger.error("oee.sync.planning_failed", error, {
            stage: "planning",
            dataset,
            retryable: false,
          });
        }
      }

      for (const dataset of datasets) {
        const registered = registeredByDataset.get(dataset) ?? [];
        const imports: ImportWindowResult[] = [];
        for (const window of registered) {
          try {
            imports.push(await this.#executeWindow(window));
          } catch {
            imports.push(this.#failedWindowResult(window));
          }
        }
        datasetResults.push({
          dataset,
          plannedWindows: registered.map(({ startDate, endDate }) => ({ startDate, endDate })),
          imports,
          ...(planningErrors.has(dataset)
            ? {
                planningError: {
                  stage: "planning" as const,
                  message: errorMessage(planningErrors.get(dataset)),
                },
              }
            : {}),
        });
      }
      const firstPlanningError = planningErrors.values().next().value;
      const status = this.#finalizeRun(
        runId,
        firstPlanningError === undefined
          ? undefined
          : { stage: "planning", error: firstPlanningError },
      );
      logger.info("oee.sync.completed", {
        command,
        status,
        windowCount: sequence,
        durationMs: this.#runDuration(runId),
      });
      return { runId, status, datasets: datasetResults };
    } catch (error) {
      this.#markRemainingWindowsInterrupted(runId);
      this.#finalizeRun(runId, { stage: "planning", error });
      const status: RunOutcome = "failed";
      logger.error("oee.sync.failed", error, { command, status, stage: "planning" });
      throw error;
    }
  }

  async #executeWindow(window: RegisteredWindow): Promise<ImportResult> {
    const logger = this.#logger.child({ importRunId: window.runId, windowId: window.id });
    const startedAt = Date.now();
    let filePath = window.filePath;
    let downloaded = false;
    let stage = "import";
    logger.info("oee.window.started", {
      dataset: window.dataset,
      sourceKind: window.sourceKind,
      requestedStartDate: window.startDate,
      requestedEndDate: window.endDate,
    });
    try {
      if (window.sourceKind === "api") {
        stage = "download";
        this.#setWindowState(window.id, "downloading", true);
        filePath = await this.#download(window.sourceRef, window.dataset, window.id, logger);
        downloaded = true;
      }
      if (!filePath) throw new Error("导入窗口缺少源文件");
      stage = "import";
      this.#setWindowState(window.id, "importing", true);
      const result = await this.#importIntoWindow(window, filePath);
      logger.info("oee.window.completed", {
        status: result.status,
        dataset: result.dataset,
        rowsReceived: result.rowsReceived,
        rowsInserted: result.rowsInserted,
        rowsDeleted: result.rowsDeleted,
        missingDates: result.missingDates,
        unexpectedDates: result.unexpectedDates,
        unscopedRowCount: result.unscopedRowCount,
        durationMs: Date.now() - startedAt,
      });
      return result;
    } catch (error) {
      this.#markWindowFailed(window.id, stage, error);
      logger.error("oee.window.failed", error, {
        stage,
        dataset: window.dataset,
        requestedStartDate: window.startDate,
        requestedEndDate: window.endDate,
        durationMs: Date.now() - startedAt,
        retryable: stage === "download",
      });
      throw error;
    } finally {
      if (downloaded && filePath) {
        await unlink(filePath).catch((error: unknown) => {
          logger.warn("oee.download.cleanup_failed", {
            stage: "cleanup",
            message: errorMessage(error),
          });
        });
      }
    }
  }

  async #importIntoWindow(window: RegisteredWindow, filePath: string): Promise<ImportResult> {
    const spec = DATASET_SPECS[window.dataset];
    const expected = expectedWindow(spec, window);
    const expectedDates = dateRange(expected.startDate, expected.endDate);
    const expectedSet = new Set(expectedDates);
    const replacedDates = new Set<string>();
    const unexpectedDates = new Set<string>();
    const observedDayCounts = new Map<string, number>();
    const fileHash = createHash("sha256");
    const deleteDate = this.#database.prepare(
      `DELETE FROM ${spec.tableName} WHERE ${spec.dataDateExpression} = ?`,
    );
    let rowsReceived = 0;
    let rowsInserted = 0;
    let rowsDeleted = 0;
    let unscopedRowCount = 0;
    let transactionOpen = false;
    try {
      this.#database.exec("BEGIN IMMEDIATE");
      transactionOpen = true;
      for await (const record of streamRecords(filePath, spec.rowKey, spec.resultKey, fileHash)) {
        const normalized = spec.dataset === "availability"
          ? normalizeAvailability(record)
          : normalizeDut(record);
        rowsReceived += 1;
        if (!normalized.dataDate) {
          unscopedRowCount += 1;
        } else {
          observedDayCounts.set(
            normalized.dataDate,
            (observedDayCounts.get(normalized.dataDate) ?? 0) + 1,
          );
          if (expectedSet.has(normalized.dataDate)) {
            if (!replacedDates.has(normalized.dataDate)) {
              rowsDeleted += rowChanges(deleteDate.run(normalized.dataDate));
              replacedDates.add(normalized.dataDate);
            }
          } else {
            unexpectedDates.add(normalized.dataDate);
          }
        }
        if (spec.dataset === "availability") this.#insertAvailability(normalized as AvailabilityRow);
        else this.#insertDut(normalized as DutRow);
        rowsInserted += 1;
      }

      const sourceSha256 = fileHash.digest("hex");
      const missingDates = expectedDates.filter((date) => !replacedDates.has(date));
      const sortedObservedDates = [...observedDayCounts.keys()].sort();
      const sortedUnexpectedDates = [...unexpectedDates].sort();
      const orderedDayCounts = Object.fromEntries(
        [...observedDayCounts.entries()].sort(([left], [right]) => left.localeCompare(right)),
      );
      const status: ImportOutcome = missingDates.length || sortedUnexpectedDates.length || unscopedRowCount
        ? "completed_with_warnings"
        : "completed";
      const completedAt = operationalTimestamp();
      const coverage = this.#coverage(spec);
      this.#database.prepare(
        `UPDATE oee_import_windows
         SET status = ?, completed_at = ?, rows_received = ?, rows_inserted = ?, rows_deleted = ?,
             unscoped_row_count = ?, observed_min_date = ?, observed_max_date = ?,
             observed_day_counts_json = ?, missing_dates_json = ?, unexpected_dates_json = ?,
             source_sha256 = ?, error_stage = NULL, error_name = NULL,
             error_code = NULL, error_message = NULL
         WHERE id = ?`,
      ).run(
        status,
        completedAt,
        rowsReceived,
        rowsInserted,
        rowsDeleted,
        unscopedRowCount,
        sortedObservedDates.at(0) ?? null,
        sortedObservedDates.at(-1) ?? null,
        JSON.stringify(orderedDayCounts),
        JSON.stringify(missingDates),
        JSON.stringify(sortedUnexpectedDates),
        sourceSha256,
        window.id,
      );
      this.#database.exec("COMMIT");
      transactionOpen = false;
      return {
        runId: window.runId,
        windowId: window.id,
        status,
        dataset: window.dataset,
        requestedStartDate: window.startDate,
        requestedEndDate: window.endDate,
        expectedStartDate: expected.startDate,
        expectedEndDate: expected.endDate,
        rowsReceived,
        rowsInserted,
        rowsDeleted,
        unscopedRowCount,
        observedMinDate: sortedObservedDates.at(0) ?? null,
        observedMaxDate: sortedObservedDates.at(-1) ?? null,
        observedDayCounts: orderedDayCounts,
        missingDates,
        unexpectedDates: sortedUnexpectedDates,
        sourceSha256,
        coverage,
      };
    } catch (error) {
      if (transactionOpen) this.#database.exec("ROLLBACK");
      throw error;
    }
  }

  #setWindowState(windowId: string, status: "downloading" | "importing", start: boolean): void {
    this.#database.prepare(
      `UPDATE oee_import_windows
       SET status = ?, started_at = CASE WHEN ? THEN COALESCE(started_at, ?) ELSE started_at END
       WHERE id = ?`,
    ).run(status, start ? 1 : 0, operationalTimestamp(), windowId);
  }

  #markWindowFailed(windowId: string, stage: string, error: unknown): void {
    const details = errorColumns(error);
    this.#database.prepare(
      `UPDATE oee_import_windows
       SET status = 'failed', completed_at = ?, error_stage = ?, error_name = ?,
           error_code = ?, error_message = ?
       WHERE id = ?`,
    ).run(
      operationalTimestamp(),
      stage,
      details.name,
      details.code,
      details.message,
      windowId,
    );
  }

  #failedWindowResult(window: RegisteredWindow): FailedWindowResult {
    const row = this.#database.prepare(
      "SELECT error_stage, error_message FROM oee_import_windows WHERE id = ?",
    ).get(window.id);
    return {
      runId: window.runId,
      windowId: window.id,
      status: "failed",
      dataset: window.dataset,
      requestedStartDate: window.startDate,
      requestedEndDate: window.endDate,
      errorStage: row ? nullableStringColumn(row, "error_stage") ?? "unknown" : "unknown",
      errorMessage: row ? nullableStringColumn(row, "error_message") ?? "导入失败" : "导入失败",
    };
  }

  #markRemainingWindowsInterrupted(runId: string): void {
    this.#database.prepare(
      `UPDATE oee_import_windows
       SET status = 'interrupted', completed_at = ?, error_stage = 'planning',
           error_name = 'InterruptedImport', error_message = '任务在执行全部窗口前中断'
       WHERE run_id = ? AND status IN ('planned', 'downloading', 'importing')`,
    ).run(operationalTimestamp(), runId);
  }

  #markRunFailed(runId: string, stage: string, error: unknown): void {
    const details = errorColumns(error);
    this.#database.prepare(
      `UPDATE oee_import_runs
       SET status = 'failed', completed_at = ?, error_stage = ?, error_name = ?,
           error_code = ?, error_message = ?
       WHERE id = ?`,
    ).run(
      operationalTimestamp(),
      stage,
      details.name,
      details.code,
      details.message,
      runId,
    );
  }

  #finishSingleRunFailure(runId: string, error: unknown): void {
    const row = this.#database.prepare(
      "SELECT COUNT(*) AS count FROM oee_import_windows WHERE run_id = ?",
    ).get(runId);
    if (row && numberColumn(row, "count") > 0) this.#finalizeRun(runId);
    else this.#markRunFailed(runId, "registration", error);
  }

  #finalizeRun(
    runId: string,
    forcedFailure?: { readonly stage: string; readonly error: unknown },
  ): RunOutcome {
    this.#markRemainingWindowsInterrupted(runId);
    const summary = this.#database.prepare(
      `SELECT COUNT(*) AS window_count,
              COALESCE(SUM(CASE WHEN status IN ('completed', 'completed_with_warnings') THEN 1 ELSE 0 END), 0)
                AS completed_count,
              COALESCE(SUM(CASE WHEN status = 'completed_with_warnings' THEN 1 ELSE 0 END), 0) AS warning_count,
              COALESCE(SUM(CASE WHEN status IN ('failed', 'interrupted') THEN 1 ELSE 0 END), 0) AS failed_count
       FROM oee_import_windows WHERE run_id = ?`,
    ).get(runId);
    if (!summary) throw new Error(`找不到导入任务 ${runId}`);
    const failedCount = numberColumn(summary, "failed_count");
    const warningCount = numberColumn(summary, "warning_count");
    const status: RunOutcome = forcedFailure || failedCount > 0
      ? "failed"
      : warningCount > 0
        ? "completed_with_warnings"
        : "completed";
    const firstError = this.#database.prepare(
      `SELECT error_stage, error_name, error_code, error_message
       FROM oee_import_windows
       WHERE run_id = ? AND status IN ('failed', 'interrupted')
       ORDER BY sequence LIMIT 1`,
    ).get(runId);
    const forcedError = forcedFailure ? errorColumns(forcedFailure.error) : null;
    this.#database.prepare(
      `UPDATE oee_import_runs
       SET status = ?, completed_at = ?, window_count = ?, completed_window_count = ?,
           warning_window_count = ?, failed_window_count = ?, error_stage = ?, error_name = ?,
           error_code = ?, error_message = ?
       WHERE id = ?`,
    ).run(
      status,
      operationalTimestamp(),
      numberColumn(summary, "window_count"),
      numberColumn(summary, "completed_count"),
      warningCount,
      failedCount,
      forcedFailure?.stage ?? (firstError ? nullableStringColumn(firstError, "error_stage") : null),
      forcedError?.name ?? (firstError ? nullableStringColumn(firstError, "error_name") : null),
      forcedError?.code ?? (firstError ? nullableStringColumn(firstError, "error_code") : null),
      forcedError?.message ?? (firstError ? nullableStringColumn(firstError, "error_message") : null),
      runId,
    );
    this.#logger.child({ importRunId: runId }).info("oee.run.completed", {
      status,
      windowCount: numberColumn(summary, "window_count"),
      completedWindowCount: numberColumn(summary, "completed_count"),
      warningWindowCount: warningCount,
      failedWindowCount: failedCount,
      durationMs: this.#runDuration(runId),
    });
    return status;
  }

  #runDuration(runId: string): number {
    const row = this.#database.prepare("SELECT started_at FROM oee_import_runs WHERE id = ?").get(runId);
    if (!row) return 0;
    const startedAt = Date.parse(stringColumn(row, "started_at"));
    return Number.isFinite(startedAt) ? Date.now() - startedAt : 0;
  }

  #latestWindowStates(dataset: OeeDataset): Map<string, { status: WindowState; windowId: string }> {
    const latest = new Map<string, { status: WindowState; windowId: string }>();
    const rows = this.#database.prepare(
      `SELECT w.id, w.status, w.requested_start_date, w.requested_end_date
       FROM oee_import_windows w
       JOIN oee_import_runs r ON r.id = w.run_id
       WHERE w.dataset = ?
       ORDER BY r.started_at, r.rowid, w.sequence`,
    ).all(dataset);
    for (const row of rows) {
      const status = stringColumn(row, "status") as WindowState;
      const windowId = stringColumn(row, "id");
      for (const date of dateRange(
        stringColumn(row, "requested_start_date"),
        stringColumn(row, "requested_end_date"),
      )) latest.set(date, { status, windowId });
    }
    return latest;
  }

  #planSyncWindows(
    dataset: OeeDataset,
    throughDate: string,
    initialStartDate: string | undefined,
    overlapDays: number,
    maxWindowDays: number,
  ): DateWindow[] {
    const spec = DATASET_SPECS[dataset];
    const latest = this.#latestWindowStates(dataset);
    if (latest.size === 0 && !initialStartDate) {
      const maxDataDate = this.#coverage(spec).maxDataDate;
      if (!maxDataDate) throw new Error(`${dataset} 尚无数据,首次同步必须提供 initialStartDate`);
      const latestRequestedDate = addDays(maxDataDate, -spec.responseDateOffsetDays);
      const anchor = latestRequestedDate < throughDate ? latestRequestedDate : throughDate;
      return mergeAndSplitWindows([{
        startDate: addDays(anchor, -(overlapDays - 1)),
        endDate: throughDate,
      }], maxWindowDays);
    }

    const knownDates = [...latest.keys()].sort();
    const earliestKnownDate = knownDates.at(0);
    const startDate = initialStartDate ?? (
      earliestKnownDate && earliestKnownDate <= throughDate
        ? earliestKnownDate
        : addDays(throughDate, -(overlapDays - 1))
    );
    if (!startDate) throw new Error(`${dataset} 尚无可追踪的同步起始日期`);
    const planned = new Set<string>();
    for (const date of dateRange(startDate, throughDate)) {
      const state = latest.get(date)?.status;
      if (!state || !COMPLETED_WINDOW_STATES.has(state)) planned.add(date);
    }
    const completed = knownDates.filter((date) =>
      date <= throughDate && COMPLETED_WINDOW_STATES.has(latest.get(date)!.status));
    const latestCompleted = completed.at(-1);
    if (latestCompleted) {
      const anchor = latestCompleted < throughDate ? latestCompleted : throughDate;
      const overlapStart = addDays(anchor, -(overlapDays - 1));
      for (const date of dateRange(overlapStart < startDate ? startDate : overlapStart, throughDate)) {
        planned.add(date);
      }
    }
    return mergeAndSplitWindows(coalesceDates([...planned]), maxWindowDays);
  }

  #datasetStatus(dataset: OeeDataset): DatasetStatus {
    const spec = DATASET_SPECS[dataset];
    const facts = this.#facts(spec);
    const latest = this.#latestWindowStates(dataset);
    const trackedDates = [...latest.keys()].sort();
    const unresolvedDates = trackedDates.filter((date) =>
      !COMPLETED_WINDOW_STATES.has(latest.get(date)!.status));
    let completedThroughDate: string | null = null;
    for (const date of trackedDates) {
      if (!COMPLETED_WINDOW_STATES.has(latest.get(date)!.status)) break;
      if (completedThroughDate && date !== addDays(completedThroughDate, 1)) break;
      completedThroughDate = date;
    }
    const auditRows = this.#windowAuditRows(dataset);
    const activeWindowIds = new Set([...latest.values()].map((state) => state.windowId));
    const issues: ImportIssue[] = auditRows
      .filter((row) => activeWindowIds.has(row.id) && (
        row.status === "completed_with_warnings" || row.status === "failed" || row.status === "interrupted"
      ))
      .map((row) => ({
        windowId: row.id,
        status: row.status as ImportIssue["status"],
        requestedStartDate: row.requestedStartDate,
        requestedEndDate: row.requestedEndDate,
        missingDates: row.missingDates,
        unexpectedDates: row.unexpectedDates,
        unscopedRowCount: row.unscopedRowCount,
        errorStage: row.errorStage,
        errorMessage: row.errorMessage,
      }));
    const unresolvedRanges = coalesceDates(unresolvedDates);
    const recommendations: ImportRecommendation[] = unresolvedRanges.map((range) => ({
      action: "sync",
      ...range,
      reason: "存在未完成、失败或中断的导入日期",
      windowIds: [...new Set(
        dateRange(range.startDate, range.endDate)
          .map((date) => latest.get(date)?.windowId)
          .filter((id): id is string => Boolean(id)),
      )],
    }));
    for (const issue of issues) {
      if (issue.status !== "completed_with_warnings") continue;
      recommendations.push({
        action: "reimport",
        startDate: issue.requestedStartDate,
        endDate: issue.requestedEndDate,
        reason: "最近一次提交存在缺日、越界或无日期数据",
        windowIds: [issue.windowId],
      });
    }

    const factLogicalStart = facts.minDataDate
      ? addDays(facts.minDataDate, -spec.responseDateOffsetDays)
      : null;
    const factLogicalEnd = facts.maxDataDate
      ? addDays(facts.maxDataDate, -spec.responseDateOffsetDays)
      : null;
    let state: DatasetStatus["tracking"]["state"];
    if (!trackedDates.length && facts.rowCount === 0) state = "empty";
    else if (!trackedDates.length) state = "legacy_untracked";
    else if (factLogicalStart && factLogicalStart < trackedDates[0]!) state = "partially_tracked";
    else state = "tracked";
    if (state === "legacy_untracked" && factLogicalStart && factLogicalEnd) {
      recommendations.push({
        action: "reimport",
        startDate: factLogicalStart,
        endDate: factLogicalEnd,
        reason: "现有事实数据没有导入审计历史",
        windowIds: [],
      });
    }
    const nextStartDate = unresolvedDates.at(0)
      ?? (completedThroughDate ? addDays(completedThroughDate, 1) : factLogicalEnd ? addDays(factLogicalEnd, 1) : null);
    return {
      dataset,
      apiEndpoint: endpointUrl(this.#apiBaseUrl, spec),
      facts,
      tracking: {
        state,
        trackedStartDate: trackedDates.at(0) ?? null,
        trackedEndDate: trackedDates.at(-1) ?? null,
        completedThroughDate,
        nextStartDate,
        unresolvedRanges,
        latestRun: this.#latestRun(dataset),
      },
      issues,
      recommendations,
    };
  }

  #windowAuditRows(dataset: OeeDataset): WindowAuditRow[] {
    return this.#database.prepare(
      `SELECT w.id, w.status, w.requested_start_date, w.requested_end_date,
              w.missing_dates_json, w.unexpected_dates_json, w.unscoped_row_count,
              w.error_stage, w.error_message
       FROM oee_import_windows w
       JOIN oee_import_runs r ON r.id = w.run_id
       WHERE w.dataset = ?
       ORDER BY r.started_at, r.rowid, w.sequence`,
    ).all(dataset).map((row): WindowAuditRow => ({
      id: stringColumn(row, "id"),
      status: stringColumn(row, "status") as WindowState,
      requestedStartDate: stringColumn(row, "requested_start_date"),
      requestedEndDate: stringColumn(row, "requested_end_date"),
      missingDates: jsonStringArray(row["missing_dates_json"]),
      unexpectedDates: jsonStringArray(row["unexpected_dates_json"]),
      unscopedRowCount: numberColumn(row, "unscoped_row_count"),
      errorStage: nullableStringColumn(row, "error_stage"),
      errorMessage: nullableStringColumn(row, "error_message"),
    }));
  }

  #latestRun(dataset: OeeDataset): DatasetStatus["tracking"]["latestRun"] {
    const row = this.#database.prepare(
      `SELECT r.id, r.command, r.status, r.started_at, r.completed_at,
              r.error_stage, r.error_message
       FROM oee_import_runs r
       WHERE EXISTS (SELECT 1 FROM oee_import_windows w WHERE w.run_id = r.id AND w.dataset = ?)
          OR json_extract(r.parameters_json, '$.dataset') = ?
          OR EXISTS (
            SELECT 1 FROM json_each(r.parameters_json, '$.datasets') WHERE value = ?
          )
       ORDER BY r.started_at DESC, r.rowid DESC LIMIT 1`,
    ).get(dataset, dataset, dataset);
    return row ? {
      runId: stringColumn(row, "id"),
      command: stringColumn(row, "command"),
      status: stringColumn(row, "status"),
      startedAt: stringColumn(row, "started_at"),
      completedAt: nullableStringColumn(row, "completed_at"),
      errorStage: nullableStringColumn(row, "error_stage"),
      errorMessage: nullableStringColumn(row, "error_message"),
    } : null;
  }

  #facts(spec: DatasetSpec): DatasetFacts {
    const grouped = this.#database.prepare(
      `SELECT ${spec.dataDateExpression} AS data_date, COUNT(*) AS row_count
       FROM ${spec.tableName}
       GROUP BY data_date
       ORDER BY data_date`,
    ).all();
    const dates: string[] = [];
    let rowCount = 0;
    let unscopedRowCount = 0;
    for (const row of grouped) {
      const count = numberColumn(row, "row_count");
      rowCount += count;
      const date = nullableStringColumn(row, "data_date");
      try {
        if (!date) throw new Error("missing date");
        normalizeDateKey(date, "data_date");
        dates.push(date);
      } catch {
        unscopedRowCount += count;
      }
    }
    const dateSet = new Set(dates);
    const missingDateRanges = dates.length > 1
      ? coalesceDates(dateRange(dates[0]!, dates.at(-1)!).filter((date) => !dateSet.has(date)))
      : [];
    return {
      minDataDate: dates.at(0) ?? null,
      maxDataDate: dates.at(-1) ?? null,
      rowCount,
      distinctDateCount: dates.length,
      missingDateRanges,
      unscopedRowCount,
    };
  }

  #coverage(spec: DatasetSpec): DatabaseCoverage {
    const facts = this.#facts(spec);
    return {
      minDataDate: facts.minDataDate,
      maxDataDate: facts.maxDataDate,
      rowCount: facts.rowCount,
      distinctDateCount: facts.distinctDateCount,
    };
  }

  #insertAvailability(row: AvailabilityRow): void {
    this.#database.prepare(
      `INSERT INTO oee_availability (
         tool_name, lot_id, final_state, step, date, shift, time_span
       ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(row.toolName, row.lotId, row.finalState, row.step, row.date, row.shift, row.timeSpan);
  }

  #insertDut(row: DutRow): void {
    const columns = [
      "machine_id", "lot_id", "touchdown_index", "start_time", "end_time", "in_qty",
      "out_qty", "total_in", "total_out", "part_num", "package_size", "test_stage",
      "test_program", "step_code", "tooling", "tester_dut_off", "handler_dut_off",
      "dut_num", "flush_flag", "mix_nomix", "hbin_info", "dut_lot_map", "td_seq_forspc",
      "full_td_index", "sbin_socket_off", "td_socket_off", "step_id", "tray_id",
      "sbin_socket_off_count", "tester_dut_off_count", "td_socket_off_count",
      "handler_dut_off_count", "partial_td", "dut_off_auto", "dut_off_manual", "date", "shift",
    ] as const;
    const values = [
      row.machineId, row.lotId, row.touchdownIndex, row.startTime, row.endTime, row.inQty,
      row.outQty, row.totalIn, row.totalOut, row.partNum, row.packageSize, row.testStage,
      row.testProgram, row.stepCode, row.tooling, row.testerDutOff, row.handlerDutOff,
      row.dutNum, row.flushFlag, row.mixNomix, row.hbinInfo, row.dutLotMap, row.tdSeqForspc,
      row.fullTdIndex, row.sbinSocketOff, row.tdSocketOff, row.stepId, row.trayId,
      row.sbinSocketOffCount, row.testerDutOffCount, row.tdSocketOffCount,
      row.handlerDutOffCount, row.partialTd, row.dutOffAuto, row.dutOffManual, row.date, row.shift,
    ] as const;
    this.#database.prepare(
      `INSERT INTO oee_dut_utilization (${columns.join(", ")})
       VALUES (${values.map(() => "?").join(", ")})`,
    ).run(...values);
  }

  async #download(
    url: string,
    dataset: OeeDataset,
    windowId: string,
    logger: AppLogger,
  ): Promise<string> {
    const incomingDirectory = path.join(path.dirname(this.#databasePath), "incoming");
    await mkdir(incomingDirectory, { recursive: true });
    let lastError: unknown;
    for (let attempt = 0; attempt <= this.#fetchRetries; attempt += 1) {
      const attemptNumber = attempt + 1;
      const attemptStartedAtMs = Date.now();
      const target = path.join(incomingDirectory, `${dataset}-${randomUUID()}.json.part`);
      this.#database.prepare(
        "UPDATE oee_import_windows SET attempt_count = ? WHERE id = ?",
      ).run(attemptNumber, windowId);
      logger.info("oee.download.attempt_started", {
        stage: "download",
        dataset,
        url,
        attempt: attemptNumber,
        maxAttempts: this.#fetchRetries + 1,
      });
      try {
        const response = await fetch(url, {
          signal: AbortSignal.timeout(this.#requestTimeoutMs),
          ...(this.#authorizationHeader
            ? { headers: { authorization: this.#authorizationHeader } }
            : {}),
        });
        if (!response.ok) {
          await response.body?.cancel();
          const message = `API 返回 HTTP ${response.status} ${response.statusText}`;
          if (!retryableStatus(response.status)) throw new NonRetryableDownloadError(message);
          throw new Error(message);
        }
        if (!response.body) throw new Error("API 响应没有正文");
        await pipeline(
          Readable.fromWeb(response.body as unknown as NodeReadableStream<Uint8Array>),
          createWriteStream(target, { flags: "wx" }),
        );
        const metadata = await stat(target);
        logger.info("oee.download.completed", {
          stage: "download",
          dataset,
          url,
          attempt: attemptNumber,
          status: response.status,
          bytes: metadata.size,
          durationMs: Date.now() - attemptStartedAtMs,
        });
        return target;
      } catch (error) {
        await unlink(target).catch(() => {});
        lastError = error;
        const willRetry = !(error instanceof NonRetryableDownloadError) && attempt < this.#fetchRetries;
        const fields = {
          stage: "download",
          dataset,
          url,
          attempt: attemptNumber,
          maxAttempts: this.#fetchRetries + 1,
          durationMs: Date.now() - attemptStartedAtMs,
        };
        if (!willRetry) {
          logger.error("oee.download.failed", error, { ...fields, retryable: false });
          break;
        }
        logger.warn("oee.download.retrying", {
          ...fields,
          error: errorMessage(error),
          retryable: true,
          retryDelayMs: 500 * 2 ** attempt,
        });
        await delay(500 * 2 ** attempt);
      }
    }
    throw new Error(`拉取 ${url} 失败:${errorMessage(lastError)}`, { cause: lastError });
  }
}
