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

interface DateWindow {
  readonly startDate: string;
  readonly endDate: string;
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
  readonly dataset: OeeDataset;
  readonly rowsReceived: number;
  readonly rowsInserted: number;
  readonly observedMinDate: string | null;
  readonly observedMaxDate: string | null;
  readonly sourceSha256: string;
  readonly coverage: DatabaseCoverage;
}

export interface DatasetStatus extends DatabaseCoverage {
  readonly dataset: OeeDataset;
  readonly apiEndpoint: string;
}

export interface SyncResult {
  readonly dataset: OeeDataset;
  readonly plannedWindows: readonly DateWindow[];
  readonly imports: readonly ImportResult[];
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
        database.prepare("SELECT 1 FROM oee_availability LIMIT 0").all();
        database.prepare("SELECT 1 FROM oee_dut_utilization LIMIT 0").all();
      } catch (error) {
        throw new Error(`数据库尚未初始化 ${resolved.databasePath};请先运行 npm run data:init`, {
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
    const spec = DATASET_SPECS[options.dataset];
    dateRange(options.requestedStartDate, options.requestedEndDate);
    const filePath = path.resolve(options.filePath);
    const sourceKind = options.sourceKind ?? "file";
    const sourceRef = options.sourceRef ?? filePath;
    const startedAtMs = Date.now();
    this.#logger.info("oee.import.started", {
      dataset: spec.dataset,
      sourceKind,
      sourceRef,
      requestedStartDate: options.requestedStartDate,
      requestedEndDate: options.requestedEndDate,
    });
    const observedDates = new Set<string>();
    const fileHash = createHash("sha256");
    let rowsReceived = 0;
    let rowsInserted = 0;
    let transactionOpen = false;

    try {
      this.#database.exec("BEGIN IMMEDIATE");
      transactionOpen = true;

      for await (const record of streamRecords(filePath, spec.rowKey, spec.resultKey, fileHash)) {
        const normalized = spec.dataset === "availability"
          ? normalizeAvailability(record)
          : normalizeDut(record);
        rowsReceived += 1;
        if (normalized.dataDate) observedDates.add(normalized.dataDate);
        if (spec.dataset === "availability") {
          this.#insertAvailability(normalized as AvailabilityRow);
        } else {
          this.#insertDut(normalized as DutRow);
        }
        rowsInserted += 1;
      }

      const sourceSha256 = fileHash.digest("hex");
      const coverage = this.#coverage(spec);
      const sortedObservedDates = [...observedDates].sort();
      const observedMinDate = sortedObservedDates.at(0) ?? null;
      const observedMaxDate = sortedObservedDates.at(-1) ?? null;
      this.#database.exec("COMMIT");
      transactionOpen = false;
      const result: ImportResult = {
        dataset: spec.dataset,
        rowsReceived,
        rowsInserted,
        observedMinDate,
        observedMaxDate,
        sourceSha256,
        coverage,
      };
      this.#logger.info("oee.import.completed", {
        ...result,
        durationMs: Date.now() - startedAtMs,
      });
      return result;
    } catch (error) {
      if (transactionOpen) this.#database.exec("ROLLBACK");
      this.#logger.error("oee.import.failed", error, {
        dataset: spec.dataset,
        sourceKind,
        sourceRef,
        requestedStartDate: options.requestedStartDate,
        requestedEndDate: options.requestedEndDate,
        rowsReceived,
        durationMs: Date.now() - startedAtMs,
      });
      throw error;
    }
  }

  async pullWindow(options: PullWindowOptions): Promise<ImportResult> {
    this.#assertOpen();
    const days = dateRange(options.startDate, options.endDate);
    if (days.length > MAX_API_WINDOW_DAYS) {
      throw new Error(`单次 API 拉取不能超过 ${MAX_API_WINDOW_DAYS} 天`);
    }
    const spec = DATASET_SPECS[options.dataset];
    const window = { startDate: options.startDate, endDate: options.endDate };
    const url = sourceUrl(this.#apiBaseUrl, spec, window);
    const startedAtMs = Date.now();
    this.#logger.info("oee.pull.started", {
      dataset: spec.dataset,
      startDate: window.startDate,
      endDate: window.endDate,
      url,
    });
    let downloadedPath: string | null = null;
    try {
      downloadedPath = await this.#download(url, spec.dataset);
      const result = await this.importFile({
        dataset: spec.dataset,
        filePath: downloadedPath,
        requestedStartDate: window.startDate,
        requestedEndDate: window.endDate,
        sourceKind: "api",
        sourceRef: url,
      });
      this.#logger.info("oee.pull.completed", {
        dataset: spec.dataset,
        startDate: window.startDate,
        endDate: window.endDate,
        rowsReceived: result.rowsReceived,
        rowsInserted: result.rowsInserted,
        durationMs: Date.now() - startedAtMs,
      });
      return result;
    } catch (error) {
      this.#logger.error("oee.pull.failed", error, {
        dataset: spec.dataset,
        startDate: window.startDate,
        endDate: window.endDate,
        url,
        durationMs: Date.now() - startedAtMs,
      });
      throw error;
    } finally {
      if (downloadedPath) await unlink(downloadedPath).catch(() => {});
    }
  }

  async sync(options: SyncOptions): Promise<SyncResult[]> {
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
    const startedAtMs = Date.now();
    this.#logger.info("oee.sync.started", {
      datasets,
      throughDate: options.throughDate,
      initialStartDate: options.initialStartDate,
      overlapDays,
      maxWindowDays,
    });
    try {
      const results: SyncResult[] = [];
      for (const dataset of datasets) {
        const windows = this.#planWindows(
          dataset,
          options.throughDate,
          options.initialStartDate,
          overlapDays,
          maxWindowDays,
        );
        this.#logger.info("oee.sync.windows_planned", { dataset, windows });
        const imports: ImportResult[] = [];
        for (const window of windows) {
          imports.push(await this.pullWindow({ dataset, ...window }));
        }
        results.push({ dataset, plannedWindows: windows, imports });
      }
      this.#logger.info("oee.sync.completed", {
        datasets,
        importCount: results.reduce((count, result) => count + result.imports.length, 0),
        durationMs: Date.now() - startedAtMs,
      });
      return results;
    } catch (error) {
      this.#logger.error("oee.sync.failed", error, {
        datasets,
        throughDate: options.throughDate,
        durationMs: Date.now() - startedAtMs,
      });
      throw error;
    }
  }

  getStatus(): DatasetStatus[] {
    this.#assertOpen();
    return OEE_DATASETS.map((dataset): DatasetStatus => {
      const spec = DATASET_SPECS[dataset];
      return {
        dataset,
        apiEndpoint: endpointUrl(this.#apiBaseUrl, spec),
        ...this.#coverage(spec),
      };
    });
  }

  close(): void {
    if (this.#closed) return;
    this.#database.close();
    this.#closed = true;
  }

  #assertOpen(): void {
    if (this.#closed) throw new Error("OeeDataStore 已关闭");
  }

  #insertAvailability(row: AvailabilityRow): void {
    this.#database.prepare(
      `INSERT INTO oee_availability (
         tool_name, lot_id, final_state, step, date, shift, time_span
       ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      row.toolName,
      row.lotId,
      row.finalState,
      row.step,
      row.date,
      row.shift,
      row.timeSpan,
    );
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

  #coverage(spec: DatasetSpec): DatabaseCoverage {
    const row = this.#database.prepare(
      `SELECT MIN(${spec.dataDateExpression}) AS min_data_date,
              MAX(${spec.dataDateExpression}) AS max_data_date,
              COUNT(*) AS row_count,
              COUNT(DISTINCT ${spec.dataDateExpression}) AS distinct_date_count
       FROM ${spec.tableName}`,
    ).get();
    if (!row) throw new Error(`无法读取 ${spec.dataset} 数据范围`);
    return {
      minDataDate: nullableStringColumn(row, "min_data_date"),
      maxDataDate: nullableStringColumn(row, "max_data_date"),
      rowCount: numberColumn(row, "row_count"),
      distinctDateCount: numberColumn(row, "distinct_date_count"),
    };
  }

  #planWindows(
    dataset: OeeDataset,
    throughDate: string,
    initialStartDate: string | undefined,
    overlapDays: number,
    maxWindowDays: number,
  ): DateWindow[] {
    if (initialStartDate) {
      return mergeAndSplitWindows(
        [{ startDate: initialStartDate, endDate: throughDate }],
        maxWindowDays,
      );
    }

    const spec = DATASET_SPECS[dataset];
    const maxDataDate = this.#coverage(spec).maxDataDate;
    if (maxDataDate) {
      const latestRequestedDate = addDays(maxDataDate, -spec.responseDateOffsetDays);
      const anchor = latestRequestedDate < throughDate ? latestRequestedDate : throughDate;
      const startDate = addDays(anchor, -(overlapDays - 1));
      return mergeAndSplitWindows([{ startDate, endDate: throughDate }], maxWindowDays);
    } else {
      throw new Error(`${dataset} 尚无数据,首次同步必须提供 initialStartDate`);
    }
  }

  async #download(url: string, dataset: OeeDataset): Promise<string> {
    const incomingDirectory = path.join(path.dirname(this.#databasePath), "incoming");
    await mkdir(incomingDirectory, { recursive: true });
    let lastError: unknown;
    for (let attempt = 0; attempt <= this.#fetchRetries; attempt += 1) {
      const attemptNumber = attempt + 1;
      const attemptStartedAtMs = Date.now();
      const target = path.join(incomingDirectory, `${dataset}-${randomUUID()}.json.part`);
      this.#logger.info("oee.download.attempt_started", {
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
        this.#logger.info("oee.download.completed", {
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
          dataset,
          url,
          attempt: attemptNumber,
          maxAttempts: this.#fetchRetries + 1,
          durationMs: Date.now() - attemptStartedAtMs,
        };
        if (!willRetry) {
          this.#logger.error("oee.download.failed", error, fields);
          break;
        }
        this.#logger.warn("oee.download.retrying", {
          ...fields,
          error: errorMessage(error),
          retryDelayMs: 500 * 2 ** attempt,
        });
        await delay(500 * 2 ** attempt);
      }
    }
    throw new Error(`拉取 ${url} 失败:${errorMessage(lastError)}`, { cause: lastError });
  }

}
