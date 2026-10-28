export type TestOeeKind = "MT" | "ST";
/** Effective OEE uses this fixed DUT-On factor for every scope and reporting period. */
export const EFFECTIVE_DUT_ON = 0.895;
export type TestOeeKindSource = "step" | "platform";
export type TestOeeSqlSource = "availability" | "dut";
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

export interface TestOeeSqlExpressions {
  readonly source: TestOeeSqlSource;
  readonly tableAlias: string | null;
  readonly startDate: string;
  readonly endDate: string;
  readonly exclusiveEndDate: string;
  readonly dayExpression: string;
  readonly machineExpression: string;
  readonly dateRangePredicate: string;
  /** Shared source filter for all OEE components, losses and coverage. */
  readonly sourceLotPredicate: string;
  /** DUT Yield LOT whitelist; combine with the calculation label, never filter the shared population. */
  readonly yieldLotPredicate?: string;
  readonly inputQuantityWithoutRetestExpression?: string;
  /** Looks up the LOT label across all imported dates, independently of the outer report filters. */
  readonly yieldCalculationLabelExpression?: string;
  readonly platformPredicate: string;
  readonly kindExpression: string;
  readonly availabilityStateExpression?: string;
  readonly idlePredicate?: string;
  readonly touchdownLabelExpression?: string;
  readonly testTimeSecondsExpression?: string;
}

export interface DefaultTestOeeSql {
  readonly startDate: string;
  readonly endDate: string;
  readonly exclusiveEndDate: string;
  readonly dailyGrain: readonly ["day", "kind"];
  readonly trimPercent: 0.2;
  readonly trimFraction: 0.002;
  readonly trimPercentPerTail: 0.1;
  readonly trimFractionPerTail: 0.001;
  readonly periodAggregation: "pooled_components";
  readonly sql: string;
}

export interface MachineDailyTestOeeSql {
  readonly periodAggregation: "pooled_components";
  readonly startDate: string;
  readonly endDate: string;
  readonly exclusiveEndDate: string;
  readonly dailyGrain: readonly ["day", "machine", "kind"];
  readonly trimPercent: 1;
  readonly trimFraction: 0.01;
  readonly trimPercentPerTail: 0.5;
  readonly trimFractionPerTail: 0.005;
  readonly testTimeUpperLimit: 1;
  readonly sql: string;
}

export type MachinePeriodGrain = "day" | "week" | "month" | "quarter";

export interface MachinePeriodTestOeeSql {
  readonly periodAggregation: "pooled_components";
  readonly startDate: string;
  readonly endDate: string;
  readonly exclusiveEndDate: string;
  readonly grain: MachinePeriodGrain;
  readonly periodGrain: readonly ["period_label", "machine", "kind"];
  readonly trimPercent: 1;
  readonly trimFraction: 0.01;
  readonly trimPercentPerTail: 0.5;
  readonly trimFractionPerTail: 0.005;
  readonly testTimeUpperLimit: 1;
  readonly sql: string;
}

export type TestOeeDashboardView = "overview" | "trends";

export interface DefaultTestOeeDashboardSql {
  readonly periodAggregation: "pooled_components";
  readonly startDate: string;
  readonly endDate: string;
  readonly view: TestOeeDashboardView;
  readonly valueScale: "percentage_points";
  readonly sql: string;
}

export interface PeriodTestOeeSql {
  readonly startDate: string;
  readonly endDate: string;
  readonly exclusiveEndDate: string;
  readonly grain: MachinePeriodGrain | "report_period";
  readonly periodGrain: readonly ["period_label", "kind"];
  readonly periodAggregation: "pooled_components";
  readonly trimPercent: 0.2;
  readonly trimFraction: 0.002;
  readonly trimPercentPerTail: 0.1;
  readonly trimFractionPerTail: 0.001;
  readonly sql: string;
}

export interface LotEligibilityResult {
  readonly lotId: string;
  readonly eligibleLot: boolean;
}

export interface MtStClassificationInput {
  readonly step: string;
  readonly machineId: string;
}

export interface MtStClassificationResult extends MtStClassificationInput {
  readonly kind: TestOeeKind | null;
  readonly source: TestOeeKindSource | null;
  readonly excludedPciePlatform: boolean;
  readonly includedInOee: boolean;
}

export interface AvailabilityStateInput {
  readonly finalState: string;
  readonly lotId: string;
}

export interface AvailabilityStateResult extends AvailabilityStateInput {
  readonly stateGroup: AvailabilityStateGroup;
  readonly machineRunning: boolean;
}

export interface NamedRatioInput {
  readonly name: string;
  readonly numerator: number;
  readonly denominator: number;
  readonly includeInProduct?: boolean;
}

export interface NamedFactorInput {
  readonly name: string;
  readonly value: number;
  readonly includeInProduct?: boolean;
}

export interface NamedRatioResult {
  readonly name: string;
  readonly numerator: number;
  readonly denominator: number;
  readonly includeInProduct: boolean;
  readonly value: number | null;
  readonly percent: number | null;
}

export interface NamedFactorResult {
  readonly name: string;
  readonly value: number;
  readonly includeInProduct: boolean;
}

export interface RatioProductResult {
  readonly ratios: readonly NamedRatioResult[];
  readonly factors: readonly NamedFactorResult[];
  readonly product: number | null;
  readonly productPercent: number | null;
}

export const VALID_OEE_LOT_PREFIXES = ["P", "M", "R", "A", "F", "L"] as const;
export const MAX_RULE_BATCH_SIZE = 200;
export const MAX_RATIO_ITEMS = 20;
export const TEST_TIME_TRIM_PERCENT = 0.2;
export const TEST_TIME_TRIM_FRACTION = 0.002;
export const TEST_TIME_TRIM_PERCENT_PER_TAIL = 0.1;
export const TEST_TIME_TRIM_FRACTION_PER_TAIL = 0.001;

/** Excel 平台表中平台名称包含 PCIe 的机台；这些机台不参与 Test OEE。 */
export const PCIE_PLATFORM_MACHINE_IDS = [
  "TSPH001",
  "TSPH002",
  "TSPH003",
  "TSPH004",
  "TSPH005",
  "TSPH006",
  "TSPH007",
  "TSPH008",
  "TSPH009",
  "TSPH010",
  "TSPH011",
  "TSPH012",
  "TSPH013",
] as const;

/** 所配置的平台会触发 ST 回退规则的机台 ID。 */
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
const PCIE_PLATFORM_MACHINE_SET = new Set<string>(PCIE_PLATFORM_MACHINE_IDS);
const SQL_IDENTIFIER_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/u;
const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/u;
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

export class TestOeeInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TestOeeInputError";
  }
}

export function isValidOeeLotId(lotId: string): boolean {
  return VALID_LOT_PREFIX_SET.has(lotId.charAt(0));
}

export function validateTestOeeLotIds(lotIds: readonly string[]): LotEligibilityResult[] {
  assertBatchSize(lotIds, "lot_ids");
  return lotIds.map((lotId) => ({ lotId, eligibleLot: isValidOeeLotId(lotId) }));
}

export function isExcludedPciePlatformMachine(machineId: string): boolean {
  return PCIE_PLATFORM_MACHINE_SET.has(machineId);
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

export function classifyTestOeeKind(step: string, machineId: string): TestOeeKind | null {
  return classifyTestOeeKindWithSource(step, machineId).kind;
}

export function classifyTestOeeKinds(
  records: readonly MtStClassificationInput[],
): MtStClassificationResult[] {
  assertBatchSize(records, "records");
  return records.map((record) => {
    const classification = classifyTestOeeKindWithSource(record.step, record.machineId);
    const excludedPciePlatform = isExcludedPciePlatformMachine(record.machineId);
    return {
      ...record,
      ...classification,
      excludedPciePlatform,
      includedInOee: !excludedPciePlatform && classification.kind !== null,
    };
  });
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

export function classifyAvailabilityStates(
  records: readonly AvailabilityStateInput[],
): AvailabilityStateResult[] {
  assertBatchSize(records, "records");
  return records.map((record) => {
    const stateGroup = classifyAvailabilityState(record.finalState, record.lotId);
    return { ...record, stateGroup, machineRunning: stateGroup === "Machine_Running" };
  });
}

function quoteSqlLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function sqlColumn(name: string, tableAlias: string | undefined): string {
  return tableAlias === undefined ? name : `${tableAlias}.${name}`;
}

function parseIsoDate(value: string, name: string): Date {
  if (!ISO_DATE_PATTERN.test(value)) {
    throw new TestOeeInputError(`${name} 必须是 YYYY-MM-DD 格式`);
  }
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    throw new TestOeeInputError(`${name} 必须是有效的自然日`);
  }
  return parsed;
}

function nextIsoDate(value: string): string {
  const parsed = parseIsoDate(value, "end_date");
  parsed.setUTCDate(parsed.getUTCDate() + 1);
  return parsed.toISOString().slice(0, 10);
}

function dateRangeSql(dateColumn: string, startDate: string, exclusiveEndDate: string): string {
  return `substr(${dateColumn},1,10)>=${quoteSqlLiteral(startDate)} AND substr(${dateColumn},1,10)<${quoteSqlLiteral(exclusiveEndDate)}`;
}

function validLotSql(column: string): string {
  return `substr(${column},1,1) IN (${VALID_OEE_LOT_PREFIXES.map(quoteSqlLiteral).join(",")})`;
}

function quantitySql(column: string): string {
  return `CAST(NULLIF(trim(${column}),'') AS REAL)`;
}

function sourceLotSql(column: string, source: TestOeeSqlSource): string {
  return `substr(${column},1,1) NOT IN (${source === "dut" ? "'Q','E','T'" : "'Q','E'"})`;
}

function inputQuantityWithoutRetestSql(tableAlias?: string): string {
  return `CASE WHEN ${sqlColumn("test_stage", tableAlias)}='1st'
    THEN ${quantitySql(sqlColumn("in_qty", tableAlias))} ELSE NULL END`;
}

function yieldCalculationLabelSql(tableAlias: string): string {
  return `CASE WHEN SUM(${inputQuantityWithoutRetestSql(tableAlias)})
    - SUM(${quantitySql(sqlColumn("out_qty", tableAlias))}) < 0 THEN 'F' ELSE 'T' END`;
}

function eligiblePlatformSql(machineColumn: string): string {
  return `${machineColumn} NOT IN (${PCIE_PLATFORM_MACHINE_IDS.map(quoteSqlLiteral).join(",")})`;
}

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

function availabilityStateSql(finalStateColumn: string, lotIdColumn: string): string {
  return `CASE
    WHEN ${finalStateColumn}='Assistance' AND ${lotIdColumn}!='None' THEN 'Assistance'
    WHEN ${finalStateColumn}='Assistance' AND ${lotIdColumn}='None' THEN 'IDLE'
    WHEN ${finalStateColumn}='Conversion' THEN 'Conversion'
    WHEN ${finalStateColumn}='HangUp' AND ${lotIdColumn}!='None' THEN 'HangUp'
    WHEN ${finalStateColumn}='HangUp' AND ${lotIdColumn}='None' THEN 'IDLE'
    WHEN ${finalStateColumn}='PM' THEN 'PM'
    WHEN ${finalStateColumn}='Handler_Flush' THEN 'Handler_Flush'
    WHEN ${finalStateColumn}='IDLE_NoWIP' THEN 'IDLE_NoWIP'
    WHEN ${finalStateColumn}='IDLE_WaitARV' THEN 'IDLE_WaitARV'
    WHEN ${finalStateColumn}='IDLE' THEN 'IDLE'
    WHEN ${finalStateColumn} IN ('IDLE_NoWIP(NoTask)','IDLE_NoTask(xCurrentLot)') THEN 'IDLE_NoWIP'
    WHEN ${finalStateColumn} IN (${Array.from(IDLE_NO_TASK_STATES).map(quoteSqlLiteral).join(",")}) THEN 'IDLE_NoTask'
    WHEN ${finalStateColumn} IN (${Array.from(GOLDEN_RUNTIME_STATES).map(quoteSqlLiteral).join(",")}) THEN 'Golden_run_time'
    WHEN substr(${finalStateColumn},1,12)='IDLE_NoTask(' AND ${finalStateColumn}!='IDLE_NoTask(xCurrentLot)' THEN 'IDLE_NoTask'
    WHEN ${finalStateColumn}='Not_Defined' THEN 'Not_Defined'
    WHEN ${finalStateColumn}='Temp_Up(Normal Retest)' AND ${lotIdColumn}='None' THEN 'Other'
    ELSE 'Machine_Running'
  END`;
}

export function getTestOeeSqlExpressions(
  source: TestOeeSqlSource,
  startDate: string,
  endDate: string,
  tableAlias?: string,
): TestOeeSqlExpressions {
  if (tableAlias !== undefined && !SQL_IDENTIFIER_PATTERN.test(tableAlias)) {
    throw new TestOeeInputError("table_alias 必须是合法的 SQL 标识符");
  }
  parseIsoDate(startDate, "start_date");
  parseIsoDate(endDate, "end_date");
  if (startDate > endDate) {
    throw new TestOeeInputError("start_date 不能晚于 end_date");
  }
  const exclusiveEndDate = nextIsoDate(endDate);
  const dateColumn = sqlColumn("date", tableAlias);
  const lotIdColumn = sqlColumn("lot_id", tableAlias);
  const sourceLotPredicate = sourceLotSql(lotIdColumn, source);
  if (source === "availability") {
    const machineColumn = sqlColumn("tool_name", tableAlias);
    return {
      source,
      tableAlias: tableAlias ?? null,
      startDate,
      endDate,
      exclusiveEndDate,
      dayExpression: `substr(${dateColumn},1,10)`,
      machineExpression: machineColumn,
      dateRangePredicate: dateRangeSql(dateColumn, startDate, exclusiveEndDate),
      sourceLotPredicate,
      platformPredicate: eligiblePlatformSql(machineColumn),
      kindExpression: kindSql(
        sqlColumn("step", tableAlias),
        machineColumn,
      ),
      availabilityStateExpression: availabilityStateSql(
        sqlColumn("final_state", tableAlias),
        lotIdColumn,
      ),
      idlePredicate: `instr(${sqlColumn("final_state", tableAlias)},'IDLE')>0`,
    };
  }
  const machineColumn = sqlColumn("machine_id", tableAlias);
  const inputQuantityWithoutRetestExpression = inputQuantityWithoutRetestSql(tableAlias);
  const historyAlias = tableAlias === "yield_history" ? "yield_history_source" : "yield_history";
  // Qualify the default outer table so the inner LOT_ID cannot shadow it.
  const outerLotColumn = sqlColumn("lot_id", tableAlias ?? "oee_dut_utilization");
  const yieldCalculationLabelExpression = `(SELECT ${yieldCalculationLabelSql(historyAlias)}
    FROM oee_dut_utilization AS ${historyAlias}
    WHERE ${historyAlias}.lot_id=${outerLotColumn}
      AND ${sourceLotSql(`${historyAlias}.lot_id`, "dut")}
      AND ${eligiblePlatformSql(`${historyAlias}.machine_id`)})`;
  const touchdownColumn = sqlColumn("touchdown_index", tableAlias);
  const trimmedTouchdownColumn = `trim(${touchdownColumn})`;
  const touchdownDigits = `(CASE WHEN substr(${trimmedTouchdownColumn},1,1) IN ('+','-')
    THEN substr(${trimmedTouchdownColumn},2) ELSE ${trimmedTouchdownColumn} END)`;
  return {
    source,
    tableAlias: tableAlias ?? null,
    startDate,
    endDate,
    exclusiveEndDate,
    dayExpression: `substr(${dateColumn},1,10)`,
    machineExpression: machineColumn,
    dateRangePredicate: dateRangeSql(dateColumn, startDate, exclusiveEndDate),
    sourceLotPredicate,
    yieldLotPredicate: validLotSql(lotIdColumn),
    inputQuantityWithoutRetestExpression,
    yieldCalculationLabelExpression,
    platformPredicate: eligiblePlatformSql(machineColumn),
    kindExpression: kindSql(
      sqlColumn("step_id", tableAlias),
      machineColumn,
    ),
    touchdownLabelExpression: `CASE
    WHEN ${touchdownColumn} IS NULL OR ${trimmedTouchdownColumn}='' THEN NULL
    WHEN ${touchdownDigits}='' OR ${touchdownDigits} GLOB '*[^0-9]*' THEN NULL
    WHEN CAST(${trimmedTouchdownColumn} AS INTEGER)=0 THEN NULL
    ELSE 1
  END`,
    testTimeSecondsExpression: `CASE
    WHEN unixepoch(${sqlColumn("start_time", tableAlias)},'subsec') IS NULL
      OR unixepoch(${sqlColumn("end_time", tableAlias)},'subsec') IS NULL THEN NULL
    ELSE CAST(
      unixepoch(${sqlColumn("end_time", tableAlias)},'subsec')
      - unixepoch(${sqlColumn("start_time", tableAlias)},'subsec') AS REAL
    )
  END`,
  };
}

/** Report quantities stay date-limited; LOT labels aggregate matching history across all imported dates. */
export function getTestOeeDutCtes(
  startDate: string,
  endDate: string,
  grain: "day_kind" | "machine_day_kind" = "day_kind",
  periodGrain: MachinePeriodGrain | "report_period" = "day",
  mapPeriodDays = false,
): string {
  const dut = getTestOeeSqlExpressions("dut", startDate, endDate, "d");
  if (dut.yieldLotPredicate === undefined || dut.inputQuantityWithoutRetestExpression === undefined
    || dut.yieldCalculationLabelExpression === undefined) {
    throw new TestOeeInputError("DUT Yield 表达式不完整");
  }
  const machineColumn = grain === "machine_day_kind" ? "machine,\n    " : "";
  const group = grain === "machine_day_kind" ? "day, machine, kind" : "day, kind";
  const trimDivisor = grain === "machine_day_kind" ? 200 : 1000;
  const period = machinePeriodExpressions(dut.dayExpression, periodGrain, startDate, endDate);
  // Materialize report rows once; CROSS JOIN drives indexed history lookups from their distinct LOTs.
  // The raw date bounds let SQLite use its date index alongside the shared business-day predicate.
  return `dut_report AS MATERIALIZED (
  SELECT
    d.id,
    d.lot_id,
    ${dut.machineExpression} AS machine,
    ${dut.dayExpression} AS source_day,
    ${mapPeriodDays ? "" : `${period.label} AS day,`}
    ${dut.kindExpression} AS kind,
    ${dut.yieldLotPredicate} AS yield_lot_eligible,
    ${dut.inputQuantityWithoutRetestExpression} AS input_quantity_without_retest,
    ${quantitySql("d.in_qty")} AS input_quantity,
    ${quantitySql("d.out_qty")} AS output_quantity,
    ${quantitySql("d.dut_num")} AS socket_quantity,
    ${dut.touchdownLabelExpression} AS touchdown_label,
    ${dut.testTimeSecondsExpression} AS test_time_seconds
  FROM oee_dut_utilization AS d
  WHERE ${dut.dateRangePredicate}
    AND d.date>=${quoteSqlLiteral(startDate)} AND d.date<${quoteSqlLiteral(dut.exclusiveEndDate)}
    AND ${dut.sourceLotPredicate}
    AND ${dut.platformPredicate}
),
dut_report_lots AS (
  SELECT DISTINCT lot_id FROM dut_report
),
dut_lot_labels AS (
  SELECT h.lot_id, ${yieldCalculationLabelSql("h")} AS yield_calculation_label
  FROM dut_report_lots AS l CROSS JOIN oee_dut_utilization AS h
  WHERE h.lot_id=l.lot_id
    AND ${sourceLotSql("h.lot_id", "dut")} AND ${eligiblePlatformSql("h.machine_id")}
  GROUP BY h.lot_id
),
dut_base AS (
  SELECT r.*, ${mapPeriodDays ? "p.day," : ""} l.yield_calculation_label,
    r.yield_lot_eligible AND l.yield_calculation_label='T' AS yield_eligible
  FROM dut_report AS r JOIN dut_lot_labels AS l ON l.lot_id=r.lot_id
  ${mapPeriodDays ? "JOIN period_days p ON p.source_day=r.source_day" : ""}
),
dut_daily_aggregate AS (
  SELECT
    ${machineColumn}day,
    kind,
    COUNT(*) AS dut_rows,
    COUNT(DISTINCT source_day) AS dut_days,
    SUM(CASE WHEN yield_eligible THEN 1 ELSE 0 END) AS yield_rows,
    SUM(CASE WHEN yield_eligible THEN input_quantity END) AS yield_input_quantity,
    SUM(CASE WHEN yield_eligible THEN output_quantity END) AS yield_output_quantity,
    SUM(input_quantity) AS input_quantity,
    SUM(output_quantity) AS output_quantity,
    SUM(socket_quantity) AS socket_quantity,
    SUM(touchdown_label) AS touchdown_count,
    SUM(test_time_seconds) AS actual_test_seconds
  FROM dut_base
  WHERE kind IN ('MT','ST')
  GROUP BY ${group}
),
duration_ranked AS (
  SELECT
    id,
    ${machineColumn}day,
    kind,
    test_time_seconds,
    ROW_NUMBER() OVER (
      PARTITION BY ${group} ORDER BY test_time_seconds, id
    ) AS low_rank,
    ROW_NUMBER() OVER (
      PARTITION BY ${group} ORDER BY test_time_seconds DESC, id DESC
    ) AS high_rank,
    COUNT(*) OVER (PARTITION BY ${group}) AS duration_count
  FROM dut_base
  WHERE kind IN ('MT','ST') AND test_time_seconds IS NOT NULL
),
duration_trimmed AS (
  SELECT
    ${machineColumn}day,
    kind,
    MAX(duration_count) AS valid_duration_rows,
    MAX(CAST(duration_count / ${trimDivisor} AS INTEGER)) AS trimmed_rows_each_tail,
    AVG(CASE
      WHEN low_rank>CAST(duration_count / ${trimDivisor} AS INTEGER)
        AND high_rank>CAST(duration_count / ${trimDivisor} AS INTEGER)
      THEN test_time_seconds
    END) AS trimmed_mean_test_seconds
  FROM duration_ranked
  GROUP BY ${group}
)`;
}

function machinePeriodExpressions(
  day: string, grain: MachinePeriodGrain | "report_period", startDate: string, endDate: string,
): { label: string; start: string; end: string; partial: string } {
  let label: string, fullStart: string, fullEnd: string;
  switch (grain) {
    case "day": label = fullStart = fullEnd = day; break;
    case "week":
      label = `strftime('%Y-W%U', ${day})`;
      fullStart = `date(${day}, '-' || strftime('%w', ${day}) || ' days')`;
      fullEnd = `date(${fullStart}, '+6 days')`;
      break;
    case "month":
      label = `substr(${day},1,7)`;
      fullStart = `date(${day}, 'start of month')`;
      fullEnd = `date(${fullStart}, '+1 month', '-1 day')`;
      break;
    case "quarter":
      label = `substr(${day},1,4) || '-Q' || CAST((CAST(substr(${day},6,2) AS INTEGER)+2)/3 AS INTEGER)`;
      fullStart = `printf('%s-%02d-01', substr(${day},1,4), ((CAST(substr(${day},6,2) AS INTEGER)-1)/3)*3+1)`;
      fullEnd = `date(${fullStart}, '+3 months', '-1 day')`;
      break;
    case "report_period":
      return { label: quoteSqlLiteral(startDate + "/" + endDate), start: quoteSqlLiteral(startDate),
        end: quoteSqlLiteral(endDate), partial: "0" };
    default: throw new TestOeeInputError("grain 必须是 day、week、month 或 quarter");
  }
  const start = `MAX(${quoteSqlLiteral(startDate)}, ${fullStart}${grain === "week" ? `, substr(${day},1,4) || '-01-01'` : ""})`;
  const end = `MIN(${quoteSqlLiteral(endDate)}, ${fullEnd}${grain === "week" ? `, substr(${day},1,4) || '-12-31'` : ""})`;
  return { label, start, end, partial: `CASE WHEN ${start}>${fullStart} OR ${end}<${fullEnd} THEN 1 ELSE 0 END` };
}

/** Shared machine-period aggregation, including the exact selected range used for rankings. */
export function getMachineTestOeeCtes(
  startDate: string, endDate: string, grain: MachinePeriodGrain | "report_period" = "day",
): string {
  const availability = getTestOeeSqlExpressions("availability", startDate, endDate, "a");
  const period = machinePeriodExpressions(availability.dayExpression, grain, startDate, endDate);
  return `availability_classified AS (
  SELECT ${availability.dayExpression} AS source_day, ${period.label} AS day,
    ${period.start} AS period_start, ${period.end} AS period_end, ${period.partial} AS is_partial_period,
    ${availability.machineExpression} AS machine,
    ${availability.kindExpression} AS kind,
    ${availability.availabilityStateExpression} AS state_group,
    ${availability.idlePredicate} AS is_idle, CAST(a.time_span AS REAL) AS state_seconds
  FROM oee_availability AS a
  WHERE ${availability.dateRangePredicate}
    AND ${availability.sourceLotPredicate} AND ${availability.platformPredicate}
),
availability_daily AS (
  SELECT day, machine, kind, COUNT(*) AS availability_rows,
    COUNT(DISTINCT source_day) AS availability_days,
    MIN(period_start) AS period_start, MAX(period_end) AS period_end,
    MAX(is_partial_period) AS is_partial_period,
    SUM(CASE WHEN state_group='Machine_Running' THEN state_seconds ELSE 0 END) AS machine_running_seconds,
    SUM(CASE WHEN is_idle THEN state_seconds ELSE 0 END) AS idle_seconds,
    SUM(CASE WHEN state_group='IDLE_NoWIP' THEN state_seconds ELSE 0 END) AS idle_no_wip_seconds,
    SUM(state_seconds) AS available_seconds,
    SUM(CASE WHEN state_group='Machine_Running' THEN state_seconds ELSE 0 END)
      / NULLIF(SUM(state_seconds), 0) AS availability,
    SUM(CASE WHEN is_idle THEN state_seconds ELSE 0 END)
      / NULLIF(SUM(state_seconds), 0) AS idle,
    SUM(CASE WHEN state_group='IDLE_NoWIP' THEN state_seconds ELSE 0 END)
      / NULLIF(SUM(state_seconds), 0) AS idle_no_wip
  FROM availability_classified
  WHERE kind IN ('MT','ST')
  GROUP BY day, machine, kind
),
availability_effective AS (
  SELECT *, availability + idle_no_wip / NULLIF(1 + (1 - idle_no_wip - availability), 0) AS effective_availability
  FROM availability_daily
),
${getTestOeeDutCtes(startDate, endDate, "machine_day_kind", grain)},
dut_daily_raw AS (
  SELECT q.*, t.valid_duration_rows, t.trimmed_rows_each_tail, t.trimmed_mean_test_seconds,
    q.input_quantity / NULLIF(q.socket_quantity, 0) AS dut_on,
    t.trimmed_mean_test_seconds * q.touchdown_count / NULLIF(q.actual_test_seconds, 0)
      AS raw_test_time_performance,
    q.yield_output_quantity / NULLIF(q.yield_input_quantity, 0) AS final_yield
  FROM dut_daily_aggregate AS q
  LEFT JOIN duration_trimmed AS t ON t.day=q.day AND t.machine=q.machine AND t.kind=q.kind
),
dut_daily AS (
  SELECT *, CASE WHEN raw_test_time_performance>1 THEN 1.0
    ELSE raw_test_time_performance END AS test_time_performance
  FROM dut_daily_raw
)`;
}

function machineTestOeeSql(startDate: string, endDate: string, grain: MachinePeriodGrain): string {
  return `WITH ${getMachineTestOeeCtes(startDate, endDate, grain)}
SELECT a.*, a.day AS period_label, d.dut_rows, COALESCE(d.dut_days, 0) AS dut_days,
  d.yield_rows, d.yield_input_quantity, d.yield_output_quantity,
  d.input_quantity, d.output_quantity, d.socket_quantity, d.touchdown_count, d.actual_test_seconds,
  d.valid_duration_rows, d.trimmed_rows_each_tail, d.trimmed_mean_test_seconds,
  d.dut_on, d.dut_on AS performance, ${EFFECTIVE_DUT_ON} AS effective_dut_on,
  d.raw_test_time_performance, d.test_time_performance, d.final_yield,
  ${grain === "day" ? `a.availability * d.dut_on * d.test_time_performance * d.final_yield AS daily_test_oee,
  a.effective_availability * ${EFFECTIVE_DUT_ON} * d.test_time_performance * d.final_yield AS daily_effective_oee,` : ""}
  a.availability * d.dut_on * d.test_time_performance * d.final_yield AS test_oee,
  a.effective_availability * ${EFFECTIVE_DUT_ON} * d.test_time_performance * d.final_yield AS effective_oee
FROM availability_effective AS a
LEFT JOIN dut_daily AS d ON d.day=a.day AND d.machine=a.machine AND d.kind=a.kind
ORDER BY a.day, a.machine, a.kind`;
}

/** Compatibility entrypoint: each machine/day/type retains its 1% trim and Test Time cap. */
export function getMachineDailyTestOeeSql(startDate: string, endDate: string): MachineDailyTestOeeSql {
  const availability = getTestOeeSqlExpressions("availability", startDate, endDate, "a");
  return {
    startDate,
    endDate,
    exclusiveEndDate: availability.exclusiveEndDate,
    dailyGrain: ["day", "machine", "kind"],
    trimPercent: 1,
    trimFraction: 0.01,
    trimPercentPerTail: 0.5,
    trimFractionPerTail: 0.005,
    periodAggregation: "pooled_components", testTimeUpperLimit: 1,
    sql: machineTestOeeSql(startDate, endDate, "day"),
  };
}

export function getMachinePeriodTestOeeSql(
  startDate: string, endDate: string, grain: MachinePeriodGrain,
): MachinePeriodTestOeeSql {
  const availability = getTestOeeSqlExpressions("availability", startDate, endDate, "a");
  if (!["day", "week", "month", "quarter"].includes(grain)) {
    throw new TestOeeInputError("grain 必须是 day、week、month 或 quarter");
  }
  return { startDate, endDate, exclusiveEndDate: availability.exclusiveEndDate,
    grain, periodGrain: ["period_label", "machine", "kind"],
    trimPercent: 1, trimFraction: 0.01, trimPercentPerTail: 0.5, trimFractionPerTail: 0.005,
    periodAggregation: "pooled_components", testTimeUpperLimit: 1, sql: machineTestOeeSql(startDate, endDate, grain) };
}

/** Aggregate each source independently; daily coverage never filters the period population. */
export function getPeriodTestOeeSql(
  startDate: string, endDate: string, grain: MachinePeriodGrain | "report_period",
): PeriodTestOeeSql {
  return periodTestOeeSql(startDate, endDate, grain);
}

function periodTestOeeSql(
  startDate: string, endDate: string, grain: MachinePeriodGrain | "report_period", includeReport = false,
): PeriodTestOeeSql {
  const a = getTestOeeSqlExpressions("availability", startDate, endDate, "a");
  const p = machinePeriodExpressions("c.day", grain, startDate, endDate);
  const dutSums = ["dut_rows", "yield_rows", "yield_input_quantity", "yield_output_quantity", "input_quantity",
    "output_quantity", "socket_quantity", "touchdown_count", "actual_test_seconds", "valid_duration_rows", "trimmed_rows_each_tail"];
  const coverageColumns = ["availability_day_type_count", "dut_day_type_count", "calculable_day_type_count",
    "effective_calculable_day_type_count"];
  const sql = `WITH RECURSIVE
calendar(day) AS (
  SELECT ${quoteSqlLiteral(startDate)}
  UNION ALL SELECT date(day,'+1 day') FROM calendar WHERE day<${quoteSqlLiteral(endDate)}
),
period_days AS (
  SELECT c.day AS source_day, ${p.label} AS day, ${p.start} AS period_start,
    ${p.end} AS period_end, ${p.partial} AS is_partial_period FROM calendar c
  ${includeReport ? `UNION ALL SELECT day, ${quoteSqlLiteral(startDate+"/"+endDate)}, ${quoteSqlLiteral(startDate)}, ${quoteSqlLiteral(endDate)}, 0 FROM calendar` : ""}
),
periods AS (
  SELECT day, MIN(period_start) AS period_start, MAX(period_end) AS period_end,
    MAX(is_partial_period) AS is_partial_period, COUNT(*) AS selected_day_count
  FROM period_days GROUP BY day
),
kinds(kind) AS (VALUES ('MT'),('ST')),
scopes(kind) AS (VALUES ('MT'),('ST'),('ALL')),
availability_classified AS MATERIALIZED (
  SELECT ${a.dayExpression} AS source_day, p.day, ${a.machineExpression} AS machine,
    ${a.kindExpression} AS kind, ${a.availabilityStateExpression} AS state_group,
    ${a.idlePredicate} AS is_idle, CAST(a.time_span AS REAL) AS state_seconds
  FROM oee_availability a JOIN period_days p ON p.source_day=${a.dayExpression}
  WHERE ${a.dateRangePredicate} AND ${a.sourceLotPredicate} AND ${a.platformPredicate}
),
availability_totals AS (
  SELECT day, s.kind, COUNT(*) AS availability_rows, COUNT(DISTINCT machine) AS machine_count,
    SUM(CASE WHEN state_group='Machine_Running' THEN state_seconds ELSE 0 END) AS machine_running_seconds,
    SUM(CASE WHEN is_idle THEN state_seconds ELSE 0 END) AS idle_seconds,
    SUM(CASE WHEN state_group='IDLE_NoWIP' THEN state_seconds ELSE 0 END) AS idle_no_wip_seconds,
    SUM(state_seconds) AS available_seconds
  FROM availability_classified a JOIN scopes s ON s.kind=a.kind OR s.kind='ALL'
  WHERE a.kind IN ('MT','ST') GROUP BY day, s.kind
),
${getTestOeeDutCtes(startDate, endDate, "day_kind", grain, true)},
dut_period AS (
  SELECT q.*, t.valid_duration_rows, t.trimmed_rows_each_tail, t.trimmed_mean_test_seconds,
    CASE WHEN q.actual_test_seconds IS NULL OR q.actual_test_seconds=0 OR q.touchdown_count IS NULL
      OR t.trimmed_mean_test_seconds IS NULL THEN NULL
      ELSE t.trimmed_mean_test_seconds * q.touchdown_count END AS expected_test_seconds
  FROM dut_daily_aggregate q LEFT JOIN duration_trimmed t ON t.day=q.day AND t.kind=q.kind
),
dut_totals AS (
  SELECT day, kind, ${dutSums.join(", ")}, trimmed_mean_test_seconds, expected_test_seconds FROM dut_period
  UNION ALL
  SELECT day, 'ALL', ${dutSums.map((c) => `SUM(${c})`).join(", ")}, NULL,
    CASE WHEN COUNT(expected_test_seconds)<COUNT(*) THEN NULL ELSE SUM(expected_test_seconds) END
  FROM dut_period GROUP BY day
),
availability_coverage AS (
  SELECT day, source_day, kind, COUNT(*) AS availability_rows, SUM(state_seconds) AS available_seconds,
    SUM(CASE WHEN state_group='Machine_Running' THEN state_seconds ELSE 0 END) AS machine_running_seconds,
    SUM(CASE WHEN state_group='IDLE_NoWIP' THEN state_seconds ELSE 0 END) AS idle_no_wip_seconds
  FROM availability_classified WHERE kind IN ('MT','ST') GROUP BY day, source_day, kind
),
dut_coverage AS (
  SELECT day, source_day, kind, COUNT(*) AS dut_rows, SUM(socket_quantity) AS socket_quantity,
    SUM(touchdown_label) AS touchdown_count, SUM(test_time_seconds) AS actual_test_seconds,
    COUNT(test_time_seconds) AS valid_duration_rows,
    SUM(CASE WHEN yield_eligible THEN input_quantity END) AS yield_input_quantity,
    SUM(CASE WHEN yield_eligible THEN output_quantity END) AS yield_output_quantity
  FROM dut_base WHERE kind IN ('MT','ST') GROUP BY day, source_day, kind
),
daily_coverage AS (
  SELECT p.day, k.kind, COALESCE(a.availability_rows,0)>0 AS has_availability,
    COALESCE(d.dut_rows,0)>0 AS has_dut,
    COALESCE(a.available_seconds!=0 AND d.socket_quantity!=0 AND d.touchdown_count IS NOT NULL
      AND d.actual_test_seconds!=0 AND d.valid_duration_rows>0
      AND d.yield_input_quantity!=0 AND d.yield_output_quantity IS NOT NULL,0) AS calculable,
    COALESCE(a.available_seconds!=0 AND d.touchdown_count IS NOT NULL
      AND d.actual_test_seconds!=0 AND d.valid_duration_rows>0
      AND d.yield_input_quantity!=0 AND d.yield_output_quantity IS NOT NULL,0) AS effective_calculable,
    a.machine_running_seconds / NULLIF(a.available_seconds,0) AS availability,
    a.idle_no_wip_seconds / NULLIF(a.available_seconds,0) AS idle_no_wip
  FROM period_days p CROSS JOIN kinds k
  LEFT JOIN availability_coverage a ON a.day=p.day AND a.source_day=p.source_day AND a.kind=k.kind
  LEFT JOIN dut_coverage d ON d.day=p.day AND d.source_day=p.source_day AND d.kind=k.kind
),
coverage_by_kind AS (
  SELECT day, kind, SUM(has_availability) AS availability_day_type_count,
    SUM(has_dut) AS dut_day_type_count, SUM(calculable) AS calculable_day_type_count,
    SUM(CASE WHEN effective_calculable AND (1+(1-idle_no_wip-availability))!=0 THEN 1 ELSE 0 END)
      AS effective_calculable_day_type_count
  FROM daily_coverage GROUP BY day, kind
),
coverage AS (
  SELECT * FROM coverage_by_kind
  UNION ALL SELECT day, 'ALL', ${coverageColumns.map((c) => `SUM(${c})`).join(", ")}
  FROM coverage_by_kind GROUP BY day
),
components AS (
  SELECT p.day AS period_label, s.kind, p.period_start, p.period_end, p.is_partial_period,
    p.selected_day_count, p.selected_day_count * CASE WHEN s.kind='ALL' THEN 2 ELSE 1 END AS selected_day_type_count,
    ${coverageColumns.map((c) => `c.${c}`).join(", ")},
    COALESCE(a.availability_rows,0) AS availability_rows, COALESCE(a.machine_count,0) AS machine_count,
    a.machine_running_seconds, a.idle_seconds, a.idle_no_wip_seconds, a.available_seconds,
    ${dutSums.map((c) => `d.${c}`).join(", ")}, d.trimmed_mean_test_seconds, d.expected_test_seconds,
    a.machine_running_seconds / NULLIF(a.available_seconds,0) AS availability,
    a.idle_seconds / NULLIF(a.available_seconds,0) AS idle,
    a.idle_no_wip_seconds / NULLIF(a.available_seconds,0) AS idle_no_wip,
    d.input_quantity / NULLIF(d.socket_quantity,0) AS dut_on,
    d.expected_test_seconds / NULLIF(d.actual_test_seconds,0) AS test_time_performance,
    d.yield_output_quantity / NULLIF(d.yield_input_quantity,0) AS final_yield
  FROM periods p CROSS JOIN scopes s
  LEFT JOIN availability_totals a ON a.day=p.day AND a.kind=s.kind
  LEFT JOIN dut_totals d ON d.day=p.day AND d.kind=s.kind
  LEFT JOIN coverage c ON c.day=p.day AND c.kind=s.kind
),
effective AS (
  SELECT *, availability + idle_no_wip / NULLIF(1+(1-idle_no_wip-availability),0) AS effective_availability
  FROM components
)
SELECT *, dut_on AS performance, ${EFFECTIVE_DUT_ON} AS effective_dut_on,
  availability * dut_on * test_time_performance * final_yield AS test_oee,
  effective_availability * ${EFFECTIVE_DUT_ON} * test_time_performance * final_yield AS effective_oee
FROM effective ORDER BY period_label, kind`;
  return { startDate, endDate, exclusiveEndDate: a.exclusiveEndDate, grain,
    periodGrain: ["period_label", "kind"], periodAggregation: "pooled_components",
    trimPercent: 0.2, trimFraction: 0.002, trimPercentPerTail: 0.1, trimFractionPerTail: 0.001, sql };
}

/** Daily rows retain their own values; repeated report values pool the entire selected range. */
export function getDefaultTestOeeSql(startDate: string, endDate: string): DefaultTestOeeSql {
  // Assign each fact to its day and report period in one query, sharing the source and LOT scan.
  const daily = periodTestOeeSql(startDate, endDate, "day", true);
  const reportLabel = quoteSqlLiteral(startDate+"/"+endDate);
  const columns = ["availability_rows", "machine_count", "machine_running_seconds", "idle_seconds", "idle_no_wip_seconds",
    "available_seconds", "dut_rows", "yield_rows", "yield_input_quantity", "yield_output_quantity", "input_quantity",
    "output_quantity", "socket_quantity", "touchdown_count", "actual_test_seconds", "valid_duration_rows",
    "trimmed_rows_each_tail", "trimmed_mean_test_seconds", "availability", "idle", "idle_no_wip",
    "effective_availability", "dut_on", "effective_dut_on", "performance", "test_time_performance", "final_yield"];
  return { startDate, endDate, exclusiveEndDate: daily.exclusiveEndDate, dailyGrain: ["day", "kind"],
    trimPercent: 0.2, trimFraction: 0.002, trimPercentPerTail: 0.1, trimFractionPerTail: 0.001,
    periodAggregation: "pooled_components",
    sql: `WITH pooled AS (${daily.sql})
SELECT d.period_label AS day, d.kind, ${columns.map((c) => `d.${c}`).join(", ")},
  d.test_oee AS daily_test_oee, r.calculable_day_type_count AS calculable_day_count,
  r.selected_day_count, r.test_oee AS period_test_oee,
  d.effective_oee AS daily_effective_oee,
  r.effective_calculable_day_type_count AS effective_calculable_day_count,
  r.effective_oee AS period_effective_oee
FROM pooled d JOIN pooled r ON r.kind=d.kind AND r.period_label=${reportLabel}
WHERE d.period_label!=${reportLabel} AND d.kind IN ('MT','ST') ORDER BY day, d.kind` };
}

/** Legacy avg_* names are stable projections of pooled metrics, not arithmetic means. */
export function getDefaultTestOeeDashboardSql(
  startDate: string, endDate: string, view: TestOeeDashboardView,
): DefaultTestOeeDashboardSql {
  const source = getPeriodTestOeeSql(startDate, endDate, view === "overview" ? "report_period" : "day");
  const fields: string[] = [];
  const project = (kind: string, source: string, target: string, percent = true): void => {
    fields.push(`${percent ? "100.0 * " : ""}MAX(CASE WHEN kind='${kind}' THEN ${source} END) AS ${target}`);
  };
  for (const [kind, prefix] of [["ALL", "avg"], ["MT", "mt"], ["ST", "st"]] as const) {
    if (view === "trends" && kind === "ALL") continue;
    const oeePrefix = kind === "ALL" ? "overall" : prefix;
    for (const [source, suffix] of [["test_oee", "oee"], ["effective_oee", "effective_oee"]]) {
      project(kind, source!, `${oeePrefix}_${suffix}_percent`);
    }
    for (const [source, suffix] of [["availability", "availability"], ["dut_on", "dut_on"],
      ["dut_on", "performance"], ["test_time_performance", "test_time"], ["final_yield", "yield"],
      ["idle", "idle"], ["effective_availability", "effective_availability"]]) {
      project(kind, source!, `${prefix}_${suffix}_percent`);
    }
    project(kind, "effective_dut_on", `${prefix}_effective_dut_on_percent`);
    if (view === "overview") {
      for (const [source, suffix] of [["test_time_performance", "test_time"], ["final_yield", "yield"]]) {
        project(kind, source!, `${prefix}_effective_${suffix}_percent`);
      }
      for (const [source, name] of [["calculable_day_type_count", "calculable"], ["selected_day_type_count", "selected"],
        ["availability_day_type_count", "availability"], ["dut_day_type_count", "dut"],
        ["effective_calculable_day_type_count", "effective_calculable"]]) {
        project(kind, source!, kind === "ALL" ? `${name}_day_type_count` : `${prefix}_${name}_day_count`, false);
      }
    }
  }
  return { startDate, endDate, view, valueScale: "percentage_points", periodAggregation: "pooled_components",
    sql: `SELECT ${view === "trends" ? "period_label AS day,\n  " : ""}${fields.join(",\n  ")}
FROM (${source.sql}) AS pooled${view === "trends" ? "\nGROUP BY period_label ORDER BY period_label" : ""}` };
}

function assertBatchSize(values: readonly unknown[], name: string): void {
  if (values.length < 1 || values.length > MAX_RULE_BATCH_SIZE) {
    throw new TestOeeInputError(`${name} 必须包含 1 至 ${MAX_RULE_BATCH_SIZE} 项`);
  }
}

function assertFinite(value: number, name: string): void {
  if (!Number.isFinite(value)) throw new TestOeeInputError(`${name} 必须是有限数字`);
}

function percentage(value: number | null, name: string): number | null {
  if (value === null) return null;
  const result = value * 100;
  assertFinite(result, `${name} 百分比`);
  return result;
}

export function calculateRatioProduct(input: {
  readonly ratios: readonly NamedRatioInput[];
  readonly factors?: readonly NamedFactorInput[];
}): RatioProductResult {
  if (input.ratios.length < 1 || input.ratios.length > MAX_RATIO_ITEMS) {
    throw new TestOeeInputError(`ratios 必须包含 1 至 ${MAX_RATIO_ITEMS} 项`);
  }
  const factors = input.factors ?? [];
  if (factors.length > MAX_RATIO_ITEMS) {
    throw new TestOeeInputError(`factors 不能超过 ${MAX_RATIO_ITEMS} 项`);
  }
  const names = new Set<string>();
  const validateName = (name: string): void => {
    if (!name.trim()) throw new TestOeeInputError("计算项名称不能为空");
    if (names.has(name)) throw new TestOeeInputError(`计算项名称不能重复：${name}`);
    names.add(name);
  };

  const ratioResults = input.ratios.map((ratio): NamedRatioResult => {
    validateName(ratio.name);
    assertFinite(ratio.numerator, `${ratio.name}.numerator`);
    assertFinite(ratio.denominator, `${ratio.name}.denominator`);
    const value = ratio.denominator === 0 ? null : ratio.numerator / ratio.denominator;
    if (value !== null) assertFinite(value, ratio.name);
    return {
      name: ratio.name,
      numerator: ratio.numerator,
      denominator: ratio.denominator,
      includeInProduct: ratio.includeInProduct ?? true,
      value,
      percent: percentage(value, ratio.name),
    };
  });
  const factorResults = factors.map((factor): NamedFactorResult => {
    validateName(factor.name);
    assertFinite(factor.value, factor.name);
    return {
      name: factor.name,
      value: factor.value,
      includeInProduct: factor.includeInProduct ?? true,
    };
  });

  const includedRatios = ratioResults.filter((ratio) => ratio.includeInProduct);
  const includedFactors = factorResults.filter((factor) => factor.includeInProduct);
  if (includedRatios.length + includedFactors.length === 0) {
    throw new TestOeeInputError("至少要有一个计算项参与乘积");
  }
  const hasUndefinedRatio = includedRatios.some((ratio) => ratio.value === null);
  let product: number | null = hasUndefinedRatio ? null : 1;
  if (product !== null) {
    for (const ratio of includedRatios) product *= ratio.value!;
    for (const factor of includedFactors) product *= factor.value;
    assertFinite(product, "乘积");
  }
  return {
    ratios: ratioResults,
    factors: factorResults,
    product,
    productPercent: percentage(product, "乘积"),
  };
}
