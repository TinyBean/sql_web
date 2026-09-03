import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream, existsSync } from "node:fs";
import { mkdir, stat, unlink } from "node:fs/promises";
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
  readonly rowKey: string;
  readonly tableName: "oee_availability" | "oee_dut_utilization";
}

interface DateWindow {
  readonly startDate: string;
  readonly endDate: string;
}

export interface OeeDataStoreOptions {
  readonly databasePath: string;
  readonly apiBaseUrl?: string;
  readonly requestTimeoutMs?: number;
  readonly fetchRetries?: number;
  readonly logger?: AppLogger;
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
  readonly runId: number;
  readonly rowsReceived: number;
  readonly rowsInserted: number;
  readonly rowsUpdated: number;
  readonly rowsUnchanged: number;
  readonly duplicateRowsInResponse: number;
  readonly recordIssueCount: number;
  readonly observedMinDate: string | null;
  readonly observedMaxDate: string | null;
  readonly missingDates: readonly string[];
  readonly partialDates: readonly string[];
  readonly outOfRangeDates: readonly string[];
  readonly sourceSha256: string;
  readonly coverage: DatabaseCoverage;
}

export interface DatasetStatus extends DatabaseCoverage {
  readonly dataset: OeeDataset;
  readonly apiEndpoint: string;
  readonly lastRequestedStartDate: string | null;
  readonly lastRequestedEndDate: string | null;
  readonly lastObservedMinDate: string | null;
  readonly lastObservedMaxDate: string | null;
  readonly openGaps: readonly {
    readonly dataDate: string;
    readonly reason: "missing_response" | "partial_response";
    readonly checkCount: number;
  }[];
}

export interface SyncResult {
  readonly dataset: OeeDataset;
  readonly plannedWindows: readonly DateWindow[];
  readonly imports: readonly ImportResult[];
}

interface AvailabilityRow {
  readonly recordKey: string;
  readonly sourceHash: string;
  readonly dataDate: string;
  readonly eventTs: number;
  readonly toolName: string;
  readonly lotId: string;
  readonly finalState: string;
  readonly stepCode: string;
  readonly shift: string;
  readonly timeSpan: number;
}

interface DutRow {
  readonly recordKey: string;
  readonly sourceHash: string;
  readonly dataDate: string;
  readonly startTime: string;
  readonly endTime: string;
  readonly startTs: number;
  readonly endTs: number;
  readonly machineId: string;
  readonly lotId: string;
  readonly dutNum: string;
  readonly touchdownIndex: number;
  readonly trayId: string;
  readonly shift: string;
  readonly inQty: number;
  readonly outQty: number;
  readonly totalIn: number;
  readonly totalOut: number;
  readonly partNum: string;
  readonly packageSize: string;
  readonly testStage: string;
  readonly testProgram: string;
  readonly stepCode: string;
  readonly stepId: string;
  readonly tooling: string;
  readonly flushFlag: string;
  readonly mixNomix: string;
  readonly fullTdIndex: number;
  readonly partialTd: number;
  readonly tdSeqForspc: number;
  readonly dutOffAuto: number;
  readonly dutOffManual: number;
  readonly handlerDutOffCount: number;
  readonly sbinSocketOffCount: number;
  readonly tdSocketOffCount: number;
  readonly testerDutOffCount: number;
  readonly dutLotMap: string;
  readonly handlerDutOff: string;
  readonly hbinInfo: string;
  readonly sbinSocketOff: string;
  readonly tdSocketOff: string;
  readonly testerDutOff: string;
  readonly hasReversedTime: boolean;
}

const DEFAULT_API_BASE_URL = "http://csj-mp-dvapp03.wdc.com:9400/json/Interface/ORPTSIP/";
const DEFAULT_REQUEST_TIMEOUT_MS = 15 * 60 * 1_000;
const DEFAULT_FETCH_RETRIES = 2;
const DEFAULT_MAX_WINDOW_DAYS = 14;
const MAX_AUDIT_RANGE_DAYS = 3_660;
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
    rowKey: "ORPTSIP.row",
    tableName: "oee_availability",
  },
  dut_utilization: {
    dataset: "dut_utilization",
    endpointName: "R_OEE_MT_TOP_DUT_UTILIZATION_2W",
    rowKey: "ORPTSIP.row",
    tableName: "oee_dut_utilization",
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
      throw new Error(`JSON 响应不完整，未能完整读取 ${this.#marker} 数组`);
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
    throw new Error(`未知数据集 ${value}；可用值为 ${OEE_DATASETS.join(", ")}`);
  }
  return value;
}

function dateFromKey(value: string, fieldName: string): Date {
  if (!DATE_PATTERN.test(value)) throw new Error(`${fieldName} 必须使用 YYYY-MM-DD 格式`);
  const date = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value) {
    throw new Error(`${fieldName} 不是有效日期：${value}`);
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
  if (days > MAX_AUDIT_RANGE_DAYS) throw new Error(`单次审计范围不能超过 ${MAX_AUDIT_RANGE_DAYS} 天`);
  return Array.from({ length: days }, (_, index) => addDays(startDate, index));
}

function compactDate(value: string): string {
  return value.replaceAll("-", "");
}

function timestampSeconds(value: string, fieldName: string): number {
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) throw new Error(`${fieldName} 不是有效时间：${value}`);
  return Math.floor(milliseconds / 1_000);
}

function sourceDataDate(value: string, fieldName: string): string {
  if (value.length < 10) throw new Error(`${fieldName} 不是有效时间：${value}`);
  return normalizeDateKey(value.slice(0, 10), fieldName);
}

function requiredString(record: JsonRecord, key: string): string {
  const value = record[key];
  if (typeof value !== "string") throw new Error(`字段 ${key} 必须是字符串`);
  return value;
}

function requiredInteger(record: JsonRecord, key: string): number {
  const value = record[key];
  const number = typeof value === "number"
    ? value
    : typeof value === "string" && value.trim() !== ""
      ? Number(value)
      : Number.NaN;
  if (!Number.isSafeInteger(number)) throw new Error(`字段 ${key} 必须是安全整数，当前值为 ${String(value)}`);
  return number;
}

function hashValues(values: readonly unknown[]): string {
  return createHash("sha256").update(JSON.stringify(values)).digest("hex");
}

function normalizeAvailability(record: JsonRecord): AvailabilityRow {
  const dataDateSource = requiredString(record, "ORPTSIP.DATE");
  const dataDate = sourceDataDate(dataDateSource, "ORPTSIP.DATE");
  const toolName = requiredString(record, "ORPTSIP.TOOL_NAME");
  const lotId = requiredString(record, "ORPTSIP.LOT_ID");
  const finalState = requiredString(record, "ORPTSIP.FINAL_STATE");
  const stepCode = requiredString(record, "ORPTSIP.STEP");
  const shift = requiredString(record, "ORPTSIP.SHIFT");
  const timeSpan = requiredInteger(record, "ORPTSIP.TIME_SPAN");
  const values = [toolName, lotId, finalState, stepCode, dataDate, shift, timeSpan] as const;
  return {
    recordKey: hashValues(values.slice(0, 6)),
    sourceHash: hashValues(values),
    dataDate,
    eventTs: timestampSeconds(dataDateSource, "ORPTSIP.DATE"),
    toolName,
    lotId,
    finalState,
    stepCode,
    shift,
    timeSpan,
  };
}

function normalizeDut(record: JsonRecord): DutRow {
  const dataDate = sourceDataDate(requiredString(record, "ORPTSIP.DATE"), "ORPTSIP.DATE");
  const startTime = requiredString(record, "ORPTSIP.START_TIME");
  const endTime = requiredString(record, "ORPTSIP.END_TIME");
  const startTs = timestampSeconds(startTime, "ORPTSIP.START_TIME");
  const endTs = timestampSeconds(endTime, "ORPTSIP.END_TIME");
  const row = {
    dataDate,
    startTime,
    endTime,
    startTs,
    endTs,
    machineId: requiredString(record, "ORPTSIP.MACHINE_ID"),
    lotId: requiredString(record, "ORPTSIP.LOT_ID"),
    dutNum: requiredString(record, "ORPTSIP.DUT_NUM"),
    touchdownIndex: requiredInteger(record, "ORPTSIP.TOUCHDOWN_INDEX"),
    trayId: requiredString(record, "ORPTSIP.TRAY_ID"),
    shift: requiredString(record, "ORPTSIP.SHIFT"),
    inQty: requiredInteger(record, "ORPTSIP.IN_QTY"),
    outQty: requiredInteger(record, "ORPTSIP.OUT_QTY"),
    totalIn: requiredInteger(record, "ORPTSIP.TOTAL_IN"),
    totalOut: requiredInteger(record, "ORPTSIP.TOTAL_OUT"),
    partNum: requiredString(record, "ORPTSIP.PART_NUM"),
    packageSize: requiredString(record, "ORPTSIP.PACKAGE_SIZE"),
    testStage: requiredString(record, "ORPTSIP.TEST_STAGE"),
    testProgram: requiredString(record, "ORPTSIP.TEST_PROGRAM"),
    stepCode: requiredString(record, "ORPTSIP.STEP_CODE"),
    stepId: requiredString(record, "ORPTSIP.STEP_ID"),
    tooling: requiredString(record, "ORPTSIP.TOOLING"),
    flushFlag: requiredString(record, "ORPTSIP.FLUSH_FLAG"),
    mixNomix: requiredString(record, "ORPTSIP.MIX_NOMIX"),
    fullTdIndex: requiredInteger(record, "ORPTSIP.FULL_TD_INDEX"),
    partialTd: requiredInteger(record, "ORPTSIP.PARTIAL_TD"),
    tdSeqForspc: requiredInteger(record, "ORPTSIP.TD_SEQ_FORSPC"),
    dutOffAuto: requiredInteger(record, "ORPTSIP.DUT_OFF_AUTO"),
    dutOffManual: requiredInteger(record, "ORPTSIP.DUT_OFF_MANUAL"),
    handlerDutOffCount: requiredInteger(record, "ORPTSIP.HANDLER_DUT_OFF_COUNT"),
    sbinSocketOffCount: requiredInteger(record, "ORPTSIP.SBIN_SOCKET_OFF_COUNT"),
    tdSocketOffCount: requiredInteger(record, "ORPTSIP.TD_SOCKET_OFF_COUNT"),
    testerDutOffCount: requiredInteger(record, "ORPTSIP.TESTER_DUT_OFF_COUNT"),
    dutLotMap: requiredString(record, "ORPTSIP.DUT_LOT_MAP"),
    handlerDutOff: requiredString(record, "ORPTSIP.HANDLER_DUT_OFF"),
    hbinInfo: requiredString(record, "ORPTSIP.HBIN_INFO"),
    sbinSocketOff: requiredString(record, "ORPTSIP.SBIN_SOCKET_OFF"),
    tdSocketOff: requiredString(record, "ORPTSIP.TD_SOCKET_OFF"),
    testerDutOff: requiredString(record, "ORPTSIP.TESTER_DUT_OFF"),
    hasReversedTime: endTs < startTs,
  };
  const identity = [row.machineId, row.lotId, row.startTime, row.touchdownIndex, row.trayId] as const;
  const content = Object.entries(row).sort(([left], [right]) => left.localeCompare(right));
  return { ...row, recordKey: hashValues(identity), sourceHash: hashValues(content) };
}

async function* streamRecords(
  filePath: string,
  rowKey: string,
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
  extractor.finish();
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

function stringColumn(row: Record<string, unknown>, key: string): string {
  const value = nullableStringColumn(row, key);
  if (value === null) throw new Error(`SQLite 字段 ${key} 不能为 NULL`);
  return value;
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
  readonly #requestTimeoutMs: number;
  readonly #fetchRetries: number;
  readonly #logger: AppLogger;
  #closed = false;

  private constructor(options: Required<OeeDataStoreOptions>, database: DatabaseSync) {
    this.#database = database;
    this.#databasePath = options.databasePath;
    this.#apiBaseUrl = options.apiBaseUrl;
    this.#requestTimeoutMs = options.requestTimeoutMs;
    this.#fetchRetries = options.fetchRetries;
    this.#logger = options.logger;
  }

  static open(options: OeeDataStoreOptions): OeeDataStore {
    const resolved: Required<OeeDataStoreOptions> = {
      databasePath: path.resolve(options.databasePath),
      apiBaseUrl: options.apiBaseUrl ?? DEFAULT_API_BASE_URL,
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
      throw new Error(`数据库不存在 ${resolved.databasePath}；请先运行 npm run data:init`);
    }
    const database = new DatabaseSync(resolved.databasePath, {
      timeout: 5_000,
      enableForeignKeyConstraints: true,
    });
    try {
      try {
        database.prepare("SELECT 1 FROM oee_dataset_state LIMIT 0").all();
      } catch (error) {
        throw new Error(`数据库尚未初始化 ${resolved.databasePath}；请先运行 npm run data:init`, {
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
    const requestedDates = dateRange(options.requestedStartDate, options.requestedEndDate);
    const filePath = path.resolve(options.filePath);
    const sourceKind = options.sourceKind ?? "file";
    const sourceRef = options.sourceRef ?? filePath;
    const now = new Date().toISOString();
    const runResult = this.#database.prepare(
      `INSERT INTO oee_ingestion_runs (
         dataset, source_kind, source_ref, requested_start_date, requested_end_date, status, started_at
       ) VALUES (?, ?, ?, ?, ?, 'running', ?)`,
    ).run(spec.dataset, sourceKind, sourceRef, options.requestedStartDate, options.requestedEndDate, now);
    const runId = Number(runResult.lastInsertRowid);
    const startedAtMs = Date.now();
    this.#logger.info("oee.import.started", {
      dataset: spec.dataset,
      runId,
      sourceKind,
      sourceRef,
      requestedStartDate: options.requestedStartDate,
      requestedEndDate: options.requestedEndDate,
    });
    const beforeCounts = this.#dateCounts(spec.tableName, requestedDates);
    const observedCounts = new Map<string, number>();
    const touchedMonths = new Set<string>();
    const fileHash = createHash("sha256");
    let rowsReceived = 0;
    let rowsInserted = 0;
    let rowsUpdated = 0;
    let rowsUnchanged = 0;
    let duplicateRows = 0;
    let recordIssueCount = 0;
    let transactionOpen = false;

    try {
      this.#database.exec(
        "DROP TABLE IF EXISTS temp.oee_import_seen; " +
        "CREATE TEMP TABLE oee_import_seen (record_key TEXT PRIMARY KEY, source_hash TEXT NOT NULL) WITHOUT ROWID; " +
        "BEGIN IMMEDIATE;",
      );
      transactionOpen = true;
      const seenInsert = this.#database.prepare(
        "INSERT OR IGNORE INTO temp.oee_import_seen(record_key, source_hash) VALUES (?, ?)",
      );
      const seenSelect = this.#database.prepare(
        "SELECT source_hash FROM temp.oee_import_seen WHERE record_key = ?",
      );

      for await (const record of streamRecords(filePath, spec.rowKey, fileHash)) {
        const normalized = spec.dataset === "availability"
          ? normalizeAvailability(record)
          : normalizeDut(record);
        rowsReceived += 1;
        observedCounts.set(normalized.dataDate, (observedCounts.get(normalized.dataDate) ?? 0) + 1);

        const seenResult = seenInsert.run(normalized.recordKey, normalized.sourceHash);
        if (Number(seenResult.changes) === 0) {
          duplicateRows += 1;
          const seen = seenSelect.get(normalized.recordKey);
          if (!seen || stringColumn(seen, "source_hash") !== normalized.sourceHash) {
            throw new Error(`同一响应内业务主键重复且内容冲突：${normalized.recordKey}`);
          }
          continue;
        }

        const outcome = spec.dataset === "availability"
          ? this.#upsertAvailability(normalized as AvailabilityRow, runId, now)
          : this.#upsertDut(normalized as DutRow, runId, now);
        if (spec.dataset === "dut_utilization") {
          const dutRow = normalized as DutRow;
          this.#recordDutTimeIssue(dutRow, runId, now);
          if (dutRow.hasReversedTime) recordIssueCount += 1;
        }
        if (outcome.kind === "inserted") rowsInserted += 1;
        else if (outcome.kind === "updated") rowsUpdated += 1;
        else rowsUnchanged += 1;
        if (outcome.kind !== "unchanged") {
          touchedMonths.add(normalized.dataDate.slice(0, 7));
          if (outcome.previousDataDate) touchedMonths.add(outcome.previousDataDate.slice(0, 7));
        }
      }

      const sourceSha256 = fileHash.digest("hex");
      const audit = this.#auditDates({
        spec,
        runId,
        requestedDates,
        beforeCounts,
        observedCounts,
        now,
      });
      this.#refreshMonthlyStats(spec.dataset, touchedMonths);
      const coverage = this.#coverage(spec);
      const observedDates = [...observedCounts.keys()].sort();
      const observedMinDate = observedDates.at(0) ?? null;
      const observedMaxDate = observedDates.at(-1) ?? null;
      this.#updateDatasetState({
        spec,
        runId,
        requestedStartDate: options.requestedStartDate,
        requestedEndDate: options.requestedEndDate,
        observedMinDate,
        observedMaxDate,
        coverage,
        now,
      });
      this.#database.prepare(
        `UPDATE oee_ingestion_runs
         SET status = 'completed', completed_at = ?, source_sha256 = ?,
             rows_received = ?, rows_inserted = ?, rows_updated = ?, rows_unchanged = ?,
             duplicate_rows_in_response = ?, record_issue_count = ?,
             observed_min_date = ?, observed_max_date = ?
         WHERE id = ?`,
      ).run(
        now,
        sourceSha256,
        rowsReceived,
        rowsInserted,
        rowsUpdated,
        rowsUnchanged,
        duplicateRows,
        recordIssueCount,
        observedMinDate,
        observedMaxDate,
        runId,
      );
      this.#database.exec("COMMIT; DROP TABLE temp.oee_import_seen;");
      transactionOpen = false;
      const result: ImportResult = {
        dataset: spec.dataset,
        runId,
        rowsReceived,
        rowsInserted,
        rowsUpdated,
        rowsUnchanged,
        duplicateRowsInResponse: duplicateRows,
        recordIssueCount,
        observedMinDate,
        observedMaxDate,
        missingDates: audit.missingDates,
        partialDates: audit.partialDates,
        outOfRangeDates: audit.outOfRangeDates,
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
      this.#database.exec("DROP TABLE IF EXISTS temp.oee_import_seen");
      this.#database.prepare(
        `UPDATE oee_ingestion_runs
         SET status = 'failed', completed_at = ?, error_message = ?, rows_received = ?,
             rows_inserted = 0, rows_updated = 0, rows_unchanged = 0,
             duplicate_rows_in_response = ?, record_issue_count = 0
         WHERE id = ?`,
      ).run(
        new Date().toISOString(),
        errorMessage(error),
        rowsReceived,
        duplicateRows,
        runId,
      );
      this.#logger.error("oee.import.failed", error, {
        dataset: spec.dataset,
        runId,
        sourceKind,
        sourceRef,
        requestedStartDate: options.requestedStartDate,
        requestedEndDate: options.requestedEndDate,
        rowsReceived,
        duplicateRowsInResponse: duplicateRows,
        durationMs: Date.now() - startedAtMs,
      });
      throw error;
    }
  }

  async pullWindow(options: PullWindowOptions): Promise<ImportResult> {
    this.#assertOpen();
    const days = dateRange(options.startDate, options.endDate);
    if (days.length > DEFAULT_MAX_WINDOW_DAYS) {
      throw new Error(`单次 API 拉取不能超过 ${DEFAULT_MAX_WINDOW_DAYS} 天`);
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
      try {
        downloadedPath = await this.#download(url, spec.dataset);
      } catch (error) {
        this.#recordFailedPull(spec.dataset, url, window, error);
        throw error;
      }
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
        runId: result.runId,
        rowsReceived: result.rowsReceived,
        rowsInserted: result.rowsInserted,
        rowsUpdated: result.rowsUpdated,
        rowsUnchanged: result.rowsUnchanged,
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
    const overlapDays = options.overlapDays ?? 2;
    const maxWindowDays = options.maxWindowDays ?? DEFAULT_MAX_WINDOW_DAYS;
    if (!Number.isInteger(overlapDays) || overlapDays < 1 || overlapDays > 14) {
      throw new Error("overlapDays 必须是 1 到 14 之间的整数");
    }
    if (!Number.isInteger(maxWindowDays) || maxWindowDays < 1 || maxWindowDays > 14) {
      throw new Error("maxWindowDays 必须是 1 到 14 之间的整数");
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
    const states = this.#database.prepare(
      `SELECT dataset, api_endpoint, min_data_date, max_data_date, row_count,
              distinct_date_count, last_requested_start_date, last_requested_end_date,
              last_observed_min_date, last_observed_max_date
       FROM oee_dataset_state ORDER BY dataset`,
    ).all();
    const gapStatement = this.#database.prepare(
      `SELECT data_date, reason, check_count
       FROM oee_data_gaps
       WHERE dataset = ? AND status = 'open'
       ORDER BY data_date`,
    );
    return states.map((state): DatasetStatus => {
      const datasetValue = stringColumn(state, "dataset");
      const dataset = parseOeeDataset(datasetValue);
      return {
        dataset,
        apiEndpoint: stringColumn(state, "api_endpoint"),
        minDataDate: nullableStringColumn(state, "min_data_date"),
        maxDataDate: nullableStringColumn(state, "max_data_date"),
        rowCount: numberColumn(state, "row_count"),
        distinctDateCount: numberColumn(state, "distinct_date_count"),
        lastRequestedStartDate: nullableStringColumn(state, "last_requested_start_date"),
        lastRequestedEndDate: nullableStringColumn(state, "last_requested_end_date"),
        lastObservedMinDate: nullableStringColumn(state, "last_observed_min_date"),
        lastObservedMaxDate: nullableStringColumn(state, "last_observed_max_date"),
        openGaps: gapStatement.all(dataset).map((gap) => {
          const reason = stringColumn(gap, "reason");
          if (reason !== "missing_response" && reason !== "partial_response") {
            throw new Error(`无法识别的数据缺口原因 ${reason}`);
          }
          return {
            dataDate: stringColumn(gap, "data_date"),
            reason,
            checkCount: numberColumn(gap, "check_count"),
          };
        }),
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

  #upsertAvailability(
    row: AvailabilityRow,
    runId: number,
    now: string,
  ): { readonly kind: "inserted" | "updated" | "unchanged"; readonly previousDataDate?: string } {
    const insert = this.#database.prepare(
      `INSERT OR IGNORE INTO oee_availability (
         record_key, data_date, event_ts, tool_name, lot_id, final_state, step_code, shift,
         time_span, source_hash, first_run_id, last_run_id, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      row.recordKey,
      row.dataDate,
      row.eventTs,
      row.toolName,
      row.lotId,
      row.finalState,
      row.stepCode,
      row.shift,
      row.timeSpan,
      row.sourceHash,
      runId,
      runId,
      now,
      now,
    );
    if (Number(insert.changes) === 1) return { kind: "inserted" };
    const existing = this.#database.prepare(
      "SELECT data_date, source_hash FROM oee_availability WHERE record_key = ?",
    ).get(row.recordKey);
    if (!existing) throw new Error(`找不到冲突的 Availability 记录 ${row.recordKey}`);
    const previousDataDate = stringColumn(existing, "data_date");
    if (stringColumn(existing, "source_hash") === row.sourceHash) return { kind: "unchanged" };
    this.#database.prepare(
      `UPDATE oee_availability
       SET data_date = ?, event_ts = ?, tool_name = ?, lot_id = ?, final_state = ?,
           step_code = ?, shift = ?, time_span = ?, source_hash = ?, last_run_id = ?, updated_at = ?
       WHERE record_key = ?`,
    ).run(
      row.dataDate,
      row.eventTs,
      row.toolName,
      row.lotId,
      row.finalState,
      row.stepCode,
      row.shift,
      row.timeSpan,
      row.sourceHash,
      runId,
      now,
      row.recordKey,
    );
    return { kind: "updated", previousDataDate };
  }

  #upsertDut(
    row: DutRow,
    runId: number,
    now: string,
  ): { readonly kind: "inserted" | "updated" | "unchanged"; readonly previousDataDate?: string } {
    const values = [
      row.recordKey, row.dataDate, row.startTime, row.endTime, row.startTs, row.endTs,
      row.machineId, row.lotId, row.dutNum, row.touchdownIndex, row.trayId, row.shift,
      row.inQty, row.outQty, row.totalIn, row.totalOut, row.partNum, row.packageSize,
      row.testStage, row.testProgram, row.stepCode, row.stepId, row.tooling, row.flushFlag,
      row.mixNomix, row.fullTdIndex, row.partialTd, row.tdSeqForspc, row.dutOffAuto,
      row.dutOffManual, row.handlerDutOffCount, row.sbinSocketOffCount,
      row.tdSocketOffCount, row.testerDutOffCount, row.sourceHash, runId, runId, now, now,
    ] as const;
    const insert = this.#database.prepare(
      `INSERT OR IGNORE INTO oee_dut_utilization (
         record_key, data_date, start_time, end_time, start_ts, end_ts, machine_id, lot_id,
         dut_num, touchdown_index, tray_id, shift, in_qty, out_qty, total_in, total_out,
         part_num, package_size, test_stage, test_program, step_code, step_id, tooling,
         flush_flag, mix_nomix, full_td_index, partial_td, td_seq_forspc, dut_off_auto,
         dut_off_manual, handler_dut_off_count, sbin_socket_off_count, td_socket_off_count,
         tester_dut_off_count, source_hash, first_run_id, last_run_id, created_at, updated_at
       ) VALUES (${values.map(() => "?").join(", ")})`,
    ).run(...values);
    let kind: "inserted" | "updated" | "unchanged";
    let previousDataDate: string | undefined;
    if (Number(insert.changes) === 1) {
      kind = "inserted";
    } else {
      const existing = this.#database.prepare(
        "SELECT data_date, source_hash FROM oee_dut_utilization WHERE record_key = ?",
      ).get(row.recordKey);
      if (!existing) throw new Error(`找不到冲突的 DUT 记录 ${row.recordKey}`);
      previousDataDate = stringColumn(existing, "data_date");
      if (stringColumn(existing, "source_hash") === row.sourceHash) return { kind: "unchanged" };
      const updateValues = values.slice(1, 34);
      this.#database.prepare(
        `UPDATE oee_dut_utilization SET
           data_date = ?, start_time = ?, end_time = ?, start_ts = ?, end_ts = ?, machine_id = ?,
           lot_id = ?, dut_num = ?, touchdown_index = ?, tray_id = ?, shift = ?, in_qty = ?,
           out_qty = ?, total_in = ?, total_out = ?, part_num = ?, package_size = ?, test_stage = ?,
           test_program = ?, step_code = ?, step_id = ?, tooling = ?, flush_flag = ?, mix_nomix = ?,
           full_td_index = ?, partial_td = ?, td_seq_forspc = ?, dut_off_auto = ?, dut_off_manual = ?,
           handler_dut_off_count = ?, sbin_socket_off_count = ?, td_socket_off_count = ?,
           tester_dut_off_count = ?, source_hash = ?, last_run_id = ?, updated_at = ?
         WHERE record_key = ?`,
      ).run(...updateValues, row.sourceHash, runId, now, row.recordKey);
      kind = "updated";
    }
    this.#database.prepare(
      `INSERT INTO oee_dut_payload (
         record_key, dut_lot_map, handler_dut_off, hbin_info, sbin_socket_off,
         td_socket_off, tester_dut_off, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(record_key) DO UPDATE SET
         dut_lot_map = excluded.dut_lot_map,
         handler_dut_off = excluded.handler_dut_off,
         hbin_info = excluded.hbin_info,
         sbin_socket_off = excluded.sbin_socket_off,
         td_socket_off = excluded.td_socket_off,
         tester_dut_off = excluded.tester_dut_off,
         updated_at = excluded.updated_at`,
    ).run(
      row.recordKey,
      row.dutLotMap,
      row.handlerDutOff,
      row.hbinInfo,
      row.sbinSocketOff,
      row.tdSocketOff,
      row.testerDutOff,
      now,
    );
    return previousDataDate ? { kind, previousDataDate } : { kind };
  }

  #recordDutTimeIssue(row: DutRow, runId: number, now: string): void {
    if (row.hasReversedTime) {
      this.#database.prepare(
        `INSERT INTO oee_record_issues (
           dataset, record_key, issue_code, status, details,
           first_seen_run_id, last_seen_run_id, occurrence_count, updated_at
         ) VALUES ('dut_utilization', ?, 'end_before_start', 'open', ?, ?, ?, 1, ?)
         ON CONFLICT(dataset, record_key, issue_code) DO UPDATE SET
           status = CASE
             WHEN oee_record_issues.status = 'accepted' THEN 'accepted'
             ELSE 'open'
           END,
           details = excluded.details,
           last_seen_run_id = excluded.last_seen_run_id,
           resolved_run_id = NULL,
           occurrence_count = oee_record_issues.occurrence_count + 1,
           updated_at = excluded.updated_at`,
      ).run(
        row.recordKey,
        `END_TIME ${row.endTime} 早于 START_TIME ${row.startTime}`,
        runId,
        runId,
        now,
      );
      return;
    }
    this.#database.prepare(
      `UPDATE oee_record_issues
       SET status = 'resolved', last_seen_run_id = ?, resolved_run_id = ?, updated_at = ?
       WHERE dataset = 'dut_utilization' AND record_key = ?
         AND issue_code = 'end_before_start' AND status = 'open'`,
    ).run(runId, runId, now, row.recordKey);
  }

  #dateCounts(tableName: DatasetSpec["tableName"], dates: readonly string[]): Map<string, number> {
    const result = new Map<string, number>();
    const statement = this.#database.prepare(`SELECT COUNT(*) AS count FROM ${tableName} WHERE data_date = ?`);
    for (const date of dates) {
      const row = statement.get(date);
      result.set(date, row ? numberColumn(row, "count") : 0);
    }
    return result;
  }

  #auditDates(options: {
    readonly spec: DatasetSpec;
    readonly runId: number;
    readonly requestedDates: readonly string[];
    readonly beforeCounts: ReadonlyMap<string, number>;
    readonly observedCounts: ReadonlyMap<string, number>;
    readonly now: string;
  }): {
    readonly missingDates: string[];
    readonly partialDates: string[];
    readonly outOfRangeDates: string[];
  } {
    const expected = new Set(options.requestedDates);
    const afterCounts = this.#dateCounts(options.spec.tableName, [
      ...new Set([...options.requestedDates, ...options.observedCounts.keys()]),
    ]);
    const insertDay = this.#database.prepare(
      `INSERT INTO oee_ingestion_run_days (
         run_id, data_date, status, response_row_count,
         database_row_count_before, database_row_count_after
       ) VALUES (?, ?, ?, ?, ?, ?)`,
    );
    const openGap = this.#database.prepare(
      `INSERT INTO oee_data_gaps (
         dataset, data_date, status, reason, last_response_row_count, database_row_count,
         first_detected_run_id, last_checked_run_id, check_count, updated_at
       ) VALUES (?, ?, 'open', ?, ?, ?, ?, ?, 1, ?)
       ON CONFLICT(dataset, data_date) DO UPDATE SET
         status = CASE WHEN oee_data_gaps.status = 'accepted' THEN 'accepted' ELSE 'open' END,
         reason = excluded.reason,
         last_response_row_count = excluded.last_response_row_count,
         database_row_count = excluded.database_row_count,
         last_checked_run_id = excluded.last_checked_run_id,
         resolved_run_id = NULL,
         check_count = oee_data_gaps.check_count + 1,
         updated_at = excluded.updated_at`,
    );
    const resolveGap = this.#database.prepare(
      `UPDATE oee_data_gaps
       SET status = 'resolved', last_response_row_count = ?, database_row_count = ?,
           last_checked_run_id = ?, resolved_run_id = ?, check_count = check_count + 1, updated_at = ?
       WHERE dataset = ? AND data_date = ? AND status = 'open'`,
    );
    const missingDates: string[] = [];
    const partialDates: string[] = [];

    for (const date of options.requestedDates) {
      const responseCount = options.observedCounts.get(date) ?? 0;
      const beforeCount = options.beforeCounts.get(date) ?? 0;
      const afterCount = afterCounts.get(date) ?? 0;
      const status = responseCount === 0
        ? "missing_response"
        : beforeCount > 0 && responseCount < beforeCount
          ? "partial_response"
          : "present";
      insertDay.run(options.runId, date, status, responseCount, beforeCount, afterCount);
      if (status === "missing_response" || status === "partial_response") {
        openGap.run(
          options.spec.dataset,
          date,
          status,
          responseCount,
          afterCount,
          options.runId,
          options.runId,
          options.now,
        );
        if (status === "missing_response") missingDates.push(date);
        else partialDates.push(date);
      } else {
        resolveGap.run(
          responseCount,
          afterCount,
          options.runId,
          options.runId,
          options.now,
          options.spec.dataset,
          date,
        );
      }
    }

    const outOfRangeDates = [...options.observedCounts.keys()]
      .filter((date) => !expected.has(date))
      .sort();
    for (const date of outOfRangeDates) {
      insertDay.run(
        options.runId,
        date,
        "out_of_range",
        options.observedCounts.get(date) ?? 0,
        0,
        afterCounts.get(date) ?? 0,
      );
    }
    return { missingDates, partialDates, outOfRangeDates };
  }

  #refreshMonthlyStats(dataset: OeeDataset, months: ReadonlySet<string>): void {
    if (months.size === 0) return;
    if (dataset === "availability") {
      const remove = this.#database.prepare(
        "DELETE FROM oee_availability_monthly_stats WHERE month_key = ?",
      );
      const insert = this.#database.prepare(
        `INSERT INTO oee_availability_monthly_stats (
           month_key, tool_name, final_state, step_code, shift, record_count, total_time_span
         )
         SELECT substr(data_date, 1, 7), tool_name, final_state, step_code, shift,
                COUNT(*), SUM(time_span)
         FROM oee_availability
         WHERE substr(data_date, 1, 7) = ?
         GROUP BY substr(data_date, 1, 7), tool_name, final_state, step_code, shift`,
      );
      for (const month of months) {
        remove.run(month);
        insert.run(month);
      }
      return;
    }

    const remove = this.#database.prepare(
      "DELETE FROM oee_dut_monthly_stats WHERE month_key = ?",
    );
    const insert = this.#database.prepare(
      `INSERT INTO oee_dut_monthly_stats (
         month_key, machine_id, part_num, package_size, test_stage, step_code, shift,
         record_count, total_duration_seconds, total_in_qty, total_out_qty,
         total_handler_dut_off, total_sbin_socket_off, total_td_socket_off,
         total_tester_dut_off
       )
       SELECT substr(data_date, 1, 7), machine_id, part_num, package_size, test_stage,
              step_code, shift, COUNT(*), SUM(MAX(end_ts - start_ts, 0)), SUM(in_qty),
              SUM(out_qty), SUM(handler_dut_off_count), SUM(sbin_socket_off_count),
              SUM(td_socket_off_count), SUM(tester_dut_off_count)
       FROM oee_dut_utilization
       WHERE substr(data_date, 1, 7) = ?
       GROUP BY substr(data_date, 1, 7), machine_id, part_num, package_size,
                test_stage, step_code, shift`,
    );
    for (const month of months) {
      remove.run(month);
      insert.run(month);
    }
  }

  #coverage(spec: DatasetSpec): DatabaseCoverage {
    const row = this.#database.prepare(
      `SELECT MIN(data_date) AS min_data_date, MAX(data_date) AS max_data_date,
              COUNT(*) AS row_count, COUNT(DISTINCT data_date) AS distinct_date_count
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

  #updateDatasetState(options: {
    readonly spec: DatasetSpec;
    readonly runId: number;
    readonly requestedStartDate: string;
    readonly requestedEndDate: string;
    readonly observedMinDate: string | null;
    readonly observedMaxDate: string | null;
    readonly coverage: DatabaseCoverage;
    readonly now: string;
  }): void {
    this.#database.prepare(
      `INSERT INTO oee_dataset_state (
         dataset, api_endpoint, min_data_date, max_data_date, row_count, distinct_date_count,
         last_successful_run_id, last_requested_start_date, last_requested_end_date,
         last_observed_min_date, last_observed_max_date, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(dataset) DO UPDATE SET
         api_endpoint = excluded.api_endpoint,
         min_data_date = excluded.min_data_date,
         max_data_date = excluded.max_data_date,
         row_count = excluded.row_count,
         distinct_date_count = excluded.distinct_date_count,
         last_successful_run_id = excluded.last_successful_run_id,
         last_requested_start_date = excluded.last_requested_start_date,
         last_requested_end_date = excluded.last_requested_end_date,
         last_observed_min_date = excluded.last_observed_min_date,
         last_observed_max_date = excluded.last_observed_max_date,
         updated_at = excluded.updated_at`,
    ).run(
      options.spec.dataset,
      endpointUrl(this.#apiBaseUrl, options.spec),
      options.coverage.minDataDate,
      options.coverage.maxDataDate,
      options.coverage.rowCount,
      options.coverage.distinctDateCount,
      options.runId,
      options.requestedStartDate,
      options.requestedEndDate,
      options.observedMinDate,
      options.observedMaxDate,
      options.now,
    );
  }

  #planWindows(
    dataset: OeeDataset,
    throughDate: string,
    initialStartDate: string | undefined,
    overlapDays: number,
    maxWindowDays: number,
  ): DateWindow[] {
    const state = this.#database.prepare(
      "SELECT max_data_date FROM oee_dataset_state WHERE dataset = ?",
    ).get(dataset);
    const maxDataDate = state ? nullableStringColumn(state, "max_data_date") : null;
    const gaps = this.#database.prepare(
      `SELECT data_date FROM oee_data_gaps
       WHERE dataset = ? AND status = 'open' AND data_date <= ?
       ORDER BY data_date`,
    ).all(dataset, throughDate).map((row) => stringColumn(row, "data_date"));
    const candidates: DateWindow[] = gaps.map((date) => ({ startDate: date, endDate: date }));

    if (maxDataDate) {
      const anchor = maxDataDate < throughDate ? maxDataDate : throughDate;
      let startDate = addDays(anchor, -(overlapDays - 1));
      if (initialStartDate && startDate < initialStartDate) startDate = initialStartDate;
      if (startDate <= throughDate) candidates.push({ startDate, endDate: throughDate });
    } else {
      if (!initialStartDate) {
        throw new Error(`${dataset} 尚无数据，首次同步必须提供 initialStartDate`);
      }
      if (initialStartDate > throughDate) {
        throw new Error(`initialStartDate ${initialStartDate} 不能晚于 throughDate ${throughDate}`);
      }
      candidates.push({ startDate: initialStartDate, endDate: throughDate });
    }
    return mergeAndSplitWindows(candidates, maxWindowDays);
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
        const response = await fetch(url, { signal: AbortSignal.timeout(this.#requestTimeoutMs) });
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
    throw new Error(`拉取 ${url} 失败：${errorMessage(lastError)}`, { cause: lastError });
  }

  #recordFailedPull(dataset: OeeDataset, url: string, window: DateWindow, error: unknown): void {
    const now = new Date().toISOString();
    this.#database.prepare(
      `INSERT INTO oee_ingestion_runs (
         dataset, source_kind, source_ref, requested_start_date, requested_end_date,
         status, started_at, completed_at, error_message
       ) VALUES (?, 'api', ?, ?, ?, 'failed', ?, ?, ?)`,
    ).run(dataset, url, window.startDate, window.endDate, now, now, errorMessage(error));
  }
}
