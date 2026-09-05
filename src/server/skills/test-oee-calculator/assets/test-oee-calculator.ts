import type { AppDatabase } from "../../../data/database.ts";

export type TestOeeKind = "MT" | "ST";
export type TestOeeKindFilter = TestOeeKind | "all";
export type TestOeeKindSource = "step" | "platform";
export type AvailabilityStateGroup =
  | "Assistance"
  | "Conversion"
  | "Golden_run_time"
  | "Handler_Flush"
  | "HangUp"
  | "IDLE"
  | "IDLE_NoTask"
  | "IDLE_NoWIP"
  | "IDLE_WaitARV"
  | "Machine_Running"
  | "Not_Defined"
  | "Other"
  | "PM";

export interface TestOeeCategoryResult {
  readonly kind: TestOeeKind;
  readonly machineCount: number;
  readonly calendarDays: number;
  readonly runningSeconds: number;
  readonly availableSeconds: number;
  readonly availability: number | null;
  readonly availabilityPercent: number | null;
  readonly inQty: number;
  readonly outQty: number;
  readonly dutNum: number;
  readonly dutOn: number | null;
  readonly dutOnPercent: number | null;
  readonly yield: number | null;
  readonly yieldPercent: number | null;
  readonly testTimePerformance: 1;
  readonly testOee: number | null;
  readonly testOeePercent: number | null;
  readonly coverage: {
    readonly availabilityRows: number;
    readonly availabilityDates: number;
    readonly dutRows: number;
    readonly dutDates: number;
  };
}

export interface TestOeeCalculationResult {
  readonly startDate: string;
  readonly endDate: string;
  readonly dateRangeInclusive: true;
  readonly lotPrefixes: readonly ["P", "M", "R", "A", "F", "L"];
  readonly testStages: "all";
  readonly availabilityMachineScope: "all_machines_in_kind";
  readonly results: readonly TestOeeCategoryResult[];
  readonly diagnostics: {
    readonly unclassifiedAvailabilityRows: number;
    readonly unclassifiedDutRows: number;
  };
}

export interface TestOeeRecordClassification {
  readonly lotId: string;
  readonly eligibleLot: boolean;
  readonly step: string;
  readonly machineId: string;
  readonly kind: TestOeeKind | null;
  readonly kindSource: TestOeeKindSource | null;
  readonly includedInCalculation: boolean;
  readonly availabilityState?: AvailabilityStateGroup;
}

interface RawCategoryMetrics {
  readonly kind: TestOeeKind;
  readonly machineCount: number;
  readonly runningSeconds: number;
  readonly availabilityRows: number;
  readonly availabilityDates: number;
  readonly inQty: number;
  readonly outQty: number;
  readonly dutNum: number;
  readonly dutRows: number;
  readonly dutDates: number;
}

export const VALID_OEE_LOT_PREFIXES = ["P", "M", "R", "A", "F", "L"] as const;

/** Machine IDs whose configured platform triggers the ST fallback rule. */
export const ST_PLATFORM_MACHINE_IDS = [
  "ADH092",
  "ADH093",
  "ADH147",
  "ADH148",
  "ADH149",
  "ADH153",
  "ADH155",
  "ADH162",
  "ADH168",
  "ADH169",
  "ADH170",
  "ADH171",
  "ADH172",
  "ADH173",
  "ADH174",
  "ADH175",
  "ADH179",
  "ADH180",
  "ADH185",
  "ADH186",
  "ADH187",
  "ADH188",
  "ADH189",
  "ADH190",
  "ADH191",
  "ADH192",
  "ADH193",
  "ADH194",
  "ADH195",
  "ADH196",
  "ADH197",
  "ADH198",
  "ADH199",
  "ADH200",
  "ADH205",
  "TSPH001",
  "TSPH002",
  "TSPH003",
  "TSPH004",
  "TSPH005",
  "TSPH006",
  "TSPH007",
  "TSPH008",
  "TSPH009",
] as const;

const VALID_LOT_PREFIX_SET = new Set<string>(VALID_OEE_LOT_PREFIXES);
const ST_PLATFORM_MACHINE_SET = new Set<string>(ST_PLATFORM_MACHINE_IDS);
const IDLE_NO_TASK_STATES = new Set([
  "IDLE_NoTask(xAllBundleReachable)",
  "IDLE_NoTask(xLeads)",
  "IDLE_NoTask(xLN2_Equipped)",
  "IDLE_NoTask(xLN2_NoEqpIdListxTestPara)",
  "IDLE_NoTask(xNull_TestProgram)",
  "IDLE_NoTask(xPackage_category)",
  "IDLE_NoTask(xPackage_size)",
  "IDLE_NoTask(xTestPara)",
  "IDLE_NoTask(xTooling_Type)",
]);
const GOLDEN_RUNTIME_STATES = new Set([
  "HANDLER_PAUSE(Golden)",
  "Handler_Executing(Golden)",
  "Loader_Unload(Golden)",
  "Machine_Initialize(Golden)",
  "Temp_Down(Golden)",
  "Temp_Up(Golden)",
  "Test(Golden)",
]);
const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/u;
const MILLISECONDS_PER_DAY = 86_400_000;
const SECONDS_PER_MACHINE_DAY = 86_400;
const MAX_DATE_RANGE_DAYS = 3_660;

export class TestOeeInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TestOeeInputError";
  }
}

export function isValidOeeLotId(lotId: string): boolean {
  return VALID_LOT_PREFIX_SET.has(lotId.charAt(0));
}

export function classifyTestOeeKind(step: string, machineId: string): TestOeeKind | null {
  return classifyTestOeeKindWithSource(step, machineId).kind;
}

export function classifyTestOeeKindWithSource(
  step: string,
  machineId: string,
): { readonly kind: TestOeeKind | null; readonly source: TestOeeKindSource | null } {
  if (step.startsWith("5") || step.startsWith("95")) return { kind: "MT", source: "step" };
  if (step.startsWith("7") || step.startsWith("97")) return { kind: "ST", source: "step" };
  if (ST_PLATFORM_MACHINE_SET.has(machineId)) return { kind: "ST", source: "platform" };
  return { kind: null, source: null };
}

export function classifyAvailabilityState(
  finalState: string,
  lotId: string,
): AvailabilityStateGroup {
  if (finalState === "Assistance") return lotId === "None" ? "IDLE" : "Assistance";
  if (finalState === "Conversion") return "Conversion";
  if (finalState === "HangUp") return lotId === "None" ? "IDLE" : "HangUp";
  if (finalState === "PM") return "PM";
  if (finalState === "Handler_Flush") return "Handler_Flush";
  if (finalState === "IDLE_NoWIP") return "IDLE_NoWIP";
  if (finalState === "IDLE_WaitARV") return "IDLE_WaitARV";
  if (finalState === "IDLE") return "IDLE";
  if (finalState === "IDLE_NoWIP(NoTask)" || finalState === "IDLE_NoTask(xCurrentLot)") {
    return "IDLE_NoWIP";
  }
  if (IDLE_NO_TASK_STATES.has(finalState)) return "IDLE_NoTask";
  if (GOLDEN_RUNTIME_STATES.has(finalState)) return "Golden_run_time";
  if (finalState.startsWith("IDLE_NoTask(") && finalState !== "IDLE_NoTask(xCurrentLot)") {
    return "IDLE_NoTask";
  }
  if (finalState === "Not_Defined") return "Not_Defined";
  if (finalState === "Temp_Up(Normal Retest)" && lotId === "None") return "Other";
  return "Machine_Running";
}

export function classifyTestOeeRecord(input: {
  readonly lotId: string;
  readonly step: string;
  readonly machineId: string;
  readonly finalState?: string;
}): TestOeeRecordClassification {
  const eligibleLot = isValidOeeLotId(input.lotId);
  const kind = classifyTestOeeKindWithSource(input.step, input.machineId);
  return {
    lotId: input.lotId,
    eligibleLot,
    step: input.step,
    machineId: input.machineId,
    kind: kind.kind,
    kindSource: kind.source,
    includedInCalculation: eligibleLot && kind.kind !== null,
    ...(input.finalState === undefined
      ? {}
      : { availabilityState: classifyAvailabilityState(input.finalState, input.lotId) }),
  };
}

function parseIsoDate(value: string, name: string): number {
  if (!ISO_DATE_PATTERN.test(value)) {
    throw new TestOeeInputError(`${name} 必须是 YYYY-MM-DD 格式`);
  }
  const timestamp = Date.parse(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString().slice(0, 10) !== value) {
    throw new TestOeeInputError(`${name} 不是有效日期`);
  }
  return timestamp;
}

export function inclusiveCalendarDays(startDate: string, endDate: string): number {
  const startTimestamp = parseIsoDate(startDate, "start_date");
  const endTimestamp = parseIsoDate(endDate, "end_date");
  if (endTimestamp < startTimestamp) {
    throw new TestOeeInputError("end_date 不能早于 start_date");
  }
  const days = Math.floor((endTimestamp - startTimestamp) / MILLISECONDS_PER_DAY) + 1;
  if (days > MAX_DATE_RANGE_DAYS) {
    throw new TestOeeInputError(`日期范围不能超过 ${MAX_DATE_RANGE_DAYS} 个自然日`);
  }
  return days;
}

function quoteSqlLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

const validLotSql = (column: string): string => (
  `substr(${column},1,1) IN (${VALID_OEE_LOT_PREFIXES.map(quoteSqlLiteral).join(",")})`
);

function kindSql(stepColumn: string, machineColumn: string): string {
  return `CASE
    WHEN substr(${stepColumn},1,1)='5' THEN 'MT'
    WHEN substr(${stepColumn},1,2)='95' THEN 'MT'
    WHEN substr(${stepColumn},1,1)='7' THEN 'ST'
    WHEN substr(${stepColumn},1,2)='97' THEN 'ST'
    WHEN ${machineColumn} IN (${ST_PLATFORM_MACHINE_IDS.map(quoteSqlLiteral).join(",")}) THEN 'ST'
    ELSE NULL
  END`;
}

function availabilityStateSql(): string {
  return `CASE
    WHEN final_state='Assistance' AND lot_id!='None' THEN 'Assistance'
    WHEN final_state='Assistance' AND lot_id='None' THEN 'IDLE'
    WHEN final_state='Conversion' THEN 'Conversion'
    WHEN final_state='HangUp' AND lot_id!='None' THEN 'HangUp'
    WHEN final_state='HangUp' AND lot_id='None' THEN 'IDLE'
    WHEN final_state='PM' THEN 'PM'
    WHEN final_state='Handler_Flush' THEN 'Handler_Flush'
    WHEN final_state='IDLE_NoWIP' THEN 'IDLE_NoWIP'
    WHEN final_state='IDLE_WaitARV' THEN 'IDLE_WaitARV'
    WHEN final_state='IDLE' THEN 'IDLE'
    WHEN final_state IN ('IDLE_NoWIP(NoTask)','IDLE_NoTask(xCurrentLot)') THEN 'IDLE_NoWIP'
    WHEN final_state IN (${Array.from(IDLE_NO_TASK_STATES).map(quoteSqlLiteral).join(",")}) THEN 'IDLE_NoTask'
    WHEN final_state IN (${Array.from(GOLDEN_RUNTIME_STATES).map(quoteSqlLiteral).join(",")}) THEN 'Golden_run_time'
    WHEN substr(final_state,1,12)='IDLE_NoTask(' AND final_state!='IDLE_NoTask(xCurrentLot)' THEN 'IDLE_NoTask'
    WHEN final_state='Not_Defined' THEN 'Not_Defined'
    WHEN final_state='Temp_Up(Normal Retest)' AND lot_id='None' THEN 'Other'
    ELSE 'Machine_Running'
  END`;
}

const availabilityKindSql = kindSql("step", "tool_name");
const dutKindSql = kindSql("step_id", "machine_id");

export const TEST_OEE_QUERY = `WITH
parameters(start_date,end_date) AS (VALUES(?,?)),
kinds(kind) AS (VALUES('MT'),('ST')),
availability_all AS (
  SELECT tool_name,${availabilityKindSql} AS kind
  FROM oee_availability
  WHERE ${validLotSql("lot_id")}
),
machine_counts AS (
  SELECT kind,COUNT(DISTINCT tool_name) AS machine_count
  FROM availability_all
  WHERE kind IS NOT NULL
  GROUP BY kind
),
availability_range AS (
  SELECT ${availabilityKindSql} AS kind,${availabilityStateSql()} AS state_group,
    time_span,date(date) AS data_date
  FROM oee_availability,parameters
  WHERE ${validLotSql("lot_id")} AND date(date) BETWEEN start_date AND end_date
),
availability_metrics AS (
  SELECT kind,
    COALESCE(SUM(CASE WHEN state_group='Machine_Running' THEN time_span ELSE 0 END),0) AS running_seconds,
    COUNT(*) AS availability_rows,
    COUNT(DISTINCT data_date) AS availability_dates
  FROM availability_range
  WHERE kind IS NOT NULL
  GROUP BY kind
),
availability_diagnostics AS (
  SELECT COALESCE(SUM(CASE WHEN kind IS NULL THEN 1 ELSE 0 END),0) AS unclassified_rows
  FROM availability_range
),
dut_range AS (
  SELECT ${dutKindSql} AS kind,in_qty,out_qty,dut_num,date(date) AS data_date
  FROM oee_dut_utilization,parameters
  WHERE ${validLotSql("lot_id")} AND date(date) BETWEEN start_date AND end_date
),
dut_metrics AS (
  SELECT kind,
    COALESCE(SUM(CAST(in_qty AS REAL)),0) AS in_qty,
    COALESCE(SUM(CAST(out_qty AS REAL)),0) AS out_qty,
    COALESCE(SUM(CAST(dut_num AS REAL)),0) AS dut_num,
    COUNT(*) AS dut_rows,
    COUNT(DISTINCT data_date) AS dut_dates
  FROM dut_range
  WHERE kind IS NOT NULL
  GROUP BY kind
),
dut_diagnostics AS (
  SELECT COALESCE(SUM(CASE WHEN kind IS NULL THEN 1 ELSE 0 END),0) AS unclassified_rows
  FROM dut_range
)
SELECT kinds.kind,
  COALESCE(machine_counts.machine_count,0) AS machine_count,
  COALESCE(availability_metrics.running_seconds,0) AS running_seconds,
  COALESCE(availability_metrics.availability_rows,0) AS availability_rows,
  COALESCE(availability_metrics.availability_dates,0) AS availability_dates,
  COALESCE(dut_metrics.in_qty,0) AS in_qty,
  COALESCE(dut_metrics.out_qty,0) AS out_qty,
  COALESCE(dut_metrics.dut_num,0) AS dut_num,
  COALESCE(dut_metrics.dut_rows,0) AS dut_rows,
  COALESCE(dut_metrics.dut_dates,0) AS dut_dates,
  availability_diagnostics.unclassified_rows AS unclassified_availability_rows,
  dut_diagnostics.unclassified_rows AS unclassified_dut_rows
FROM kinds
LEFT JOIN machine_counts USING(kind)
LEFT JOIN availability_metrics USING(kind)
LEFT JOIN dut_metrics USING(kind)
CROSS JOIN availability_diagnostics
CROSS JOIN dut_diagnostics
ORDER BY kinds.kind`;

function numericField(row: Readonly<Record<string, string | number | null>>, name: string): number {
  const value = row[name];
  const result = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(result)) throw new Error(`Test OEE 查询字段 ${name} 不是有效数字`);
  return result;
}

function divide(numerator: number, denominator: number): number | null {
  return denominator === 0 ? null : numerator / denominator;
}

function percentage(value: number | null): number | null {
  return value === null ? null : value * 100;
}

export function calculateTestOeeCategory(
  raw: RawCategoryMetrics,
  calendarDays: number,
): TestOeeCategoryResult {
  const availableSeconds = raw.machineCount * calendarDays * SECONDS_PER_MACHINE_DAY;
  const availability = divide(raw.runningSeconds, availableSeconds);
  const dutOn = divide(raw.inQty, raw.dutNum);
  const yieldValue = divide(raw.outQty, raw.inQty);
  const testOee = availability === null || dutOn === null || yieldValue === null
    ? null
    : availability * dutOn * yieldValue;
  return {
    kind: raw.kind,
    machineCount: raw.machineCount,
    calendarDays,
    runningSeconds: raw.runningSeconds,
    availableSeconds,
    availability,
    availabilityPercent: percentage(availability),
    inQty: raw.inQty,
    outQty: raw.outQty,
    dutNum: raw.dutNum,
    dutOn,
    dutOnPercent: percentage(dutOn),
    yield: yieldValue,
    yieldPercent: percentage(yieldValue),
    testTimePerformance: 1,
    testOee,
    testOeePercent: percentage(testOee),
    coverage: {
      availabilityRows: raw.availabilityRows,
      availabilityDates: raw.availabilityDates,
      dutRows: raw.dutRows,
      dutDates: raw.dutDates,
    },
  };
}

export function calculateTestOee(
  database: AppDatabase,
  startDate: string,
  endDate: string,
  kindFilter: TestOeeKindFilter = "all",
): TestOeeCalculationResult {
  const calendarDays = inclusiveCalendarDays(startDate, endDate);
  const query = database.query(TEST_OEE_QUERY, [startDate, endDate], { maxRows: 2 });
  if (query.truncated || query.rows.length !== 2) {
    throw new Error("Test OEE 查询没有返回完整的 MT/ST 汇总结果");
  }
  const rawResults = query.rows.map((row): RawCategoryMetrics => {
    const kind = row["kind"];
    if (kind !== "MT" && kind !== "ST") throw new Error("Test OEE 查询返回未知分类");
    return {
      kind,
      machineCount: numericField(row, "machine_count"),
      runningSeconds: numericField(row, "running_seconds"),
      availabilityRows: numericField(row, "availability_rows"),
      availabilityDates: numericField(row, "availability_dates"),
      inQty: numericField(row, "in_qty"),
      outQty: numericField(row, "out_qty"),
      dutNum: numericField(row, "dut_num"),
      dutRows: numericField(row, "dut_rows"),
      dutDates: numericField(row, "dut_dates"),
    };
  });
  const firstRow = query.rows[0];
  if (!firstRow) throw new Error("Test OEE 查询未返回诊断信息");
  return {
    startDate,
    endDate,
    dateRangeInclusive: true,
    lotPrefixes: VALID_OEE_LOT_PREFIXES,
    testStages: "all",
    availabilityMachineScope: "all_machines_in_kind",
    results: rawResults
      .filter((row) => kindFilter === "all" || row.kind === kindFilter)
      .map((row) => calculateTestOeeCategory(row, calendarDays)),
    diagnostics: {
      unclassifiedAvailabilityRows: numericField(firstRow, "unclassified_availability_rows"),
      unclassifiedDutRows: numericField(firstRow, "unclassified_dut_rows"),
    },
  };
}
