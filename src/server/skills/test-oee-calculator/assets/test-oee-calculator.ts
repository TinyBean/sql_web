export type TestOeeKind = "MT" | "ST";
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
  readonly lotPredicate: string;
  readonly platformPredicate: string;
  readonly kindExpression: string;
  readonly availabilityStateExpression?: string;
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
  readonly periodAggregation: "average_of_daily_oee";
  readonly sql: string;
}

export type TestOeeDashboardView = "overview" | "trends";

export interface DefaultTestOeeDashboardSql {
  readonly startDate: string;
  readonly endDate: string;
  readonly view: TestOeeDashboardView;
  readonly valueScale: "percentage_points";
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
export const TEST_OEE_DAY_SECONDS = 86_400;
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
      lotPredicate: validLotSql(lotIdColumn),
      platformPredicate: eligiblePlatformSql(machineColumn),
      kindExpression: kindSql(
        sqlColumn("step", tableAlias),
        machineColumn,
      ),
      availabilityStateExpression: availabilityStateSql(
        sqlColumn("final_state", tableAlias),
        lotIdColumn,
      ),
    };
  }
  const machineColumn = sqlColumn("machine_id", tableAlias);
  const touchdownColumn = sqlColumn("touchdown_index", tableAlias);
  const trimmedTouchdownColumn = `trim(${touchdownColumn})`;
  return {
    source,
    tableAlias: tableAlias ?? null,
    startDate,
    endDate,
    exclusiveEndDate,
    dayExpression: `substr(${dateColumn},1,10)`,
    machineExpression: machineColumn,
    dateRangePredicate: dateRangeSql(dateColumn, startDate, exclusiveEndDate),
    lotPredicate: validLotSql(lotIdColumn),
    platformPredicate: eligiblePlatformSql(machineColumn),
    kindExpression: kindSql(
      sqlColumn("step_id", tableAlias),
      machineColumn,
    ),
    touchdownLabelExpression: `CASE
    WHEN ${touchdownColumn} IS NULL OR ${trimmedTouchdownColumn}='' THEN NULL
    WHEN ${trimmedTouchdownColumn} GLOB '*[^0-9]*' THEN NULL
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

export function getDefaultTestOeeSql(startDate: string, endDate: string): DefaultTestOeeSql {
  const availability = getTestOeeSqlExpressions("availability", startDate, endDate, "a");
  const dut = getTestOeeSqlExpressions("dut", startDate, endDate, "d");
  if (
    availability.availabilityStateExpression === undefined ||
    dut.touchdownLabelExpression === undefined ||
    dut.testTimeSecondsExpression === undefined
  ) {
    throw new TestOeeInputError("默认 Test OEE SQL 表达式不完整");
  }

  const sql = `WITH RECURSIVE
calendar(day) AS (
  SELECT ${quoteSqlLiteral(startDate)}
  UNION ALL
  SELECT date(day,'+1 day') FROM calendar WHERE day<${quoteSqlLiteral(endDate)}
),
kinds(kind) AS (VALUES ('MT'),('ST')),
availability_classified AS (
  SELECT
    ${availability.dayExpression} AS day,
    ${availability.machineExpression} AS machine,
    ${availability.kindExpression} AS kind,
    ${availability.availabilityStateExpression} AS state_group,
    CAST(a.time_span AS REAL) AS state_seconds
  FROM oee_availability AS a
  WHERE ${availability.dateRangePredicate}
    AND ${availability.lotPredicate}
    AND ${availability.platformPredicate}
),
availability_daily AS (
  SELECT
    day,
    kind,
    COUNT(*) AS availability_rows,
    COUNT(DISTINCT machine) AS machine_count,
    SUM(CASE WHEN state_group='Machine_Running' THEN state_seconds ELSE 0 END)
      AS machine_running_seconds,
    COUNT(DISTINCT machine) * ${TEST_OEE_DAY_SECONDS} AS available_seconds,
    CASE
      WHEN COUNT(DISTINCT machine)=0 THEN NULL
      ELSE SUM(CASE WHEN state_group='Machine_Running' THEN state_seconds ELSE 0 END)
        / (COUNT(DISTINCT machine) * ${TEST_OEE_DAY_SECONDS}.0)
    END AS availability
  FROM availability_classified
  WHERE kind IN ('MT','ST')
  GROUP BY day, kind
),
dut_base AS (
  SELECT
    d.id,
    ${dut.dayExpression} AS day,
    ${dut.kindExpression} AS kind,
    CAST(NULLIF(trim(d.in_qty),'') AS REAL) AS input_quantity,
    CAST(NULLIF(trim(d.out_qty),'') AS REAL) AS output_quantity,
    CAST(NULLIF(trim(d.dut_num),'') AS REAL) AS socket_quantity,
    ${dut.touchdownLabelExpression} AS touchdown_label,
    ${dut.testTimeSecondsExpression} AS test_time_seconds
  FROM oee_dut_utilization AS d
  WHERE ${dut.dateRangePredicate}
    AND ${dut.lotPredicate}
    AND ${dut.platformPredicate}
),
dut_daily_aggregate AS (
  SELECT
    day,
    kind,
    COUNT(*) AS dut_rows,
    SUM(input_quantity) AS input_quantity,
    SUM(output_quantity) AS output_quantity,
    SUM(socket_quantity) AS socket_quantity,
    SUM(touchdown_label) AS touchdown_count,
    SUM(test_time_seconds) AS actual_test_seconds
  FROM dut_base
  WHERE kind IN ('MT','ST')
  GROUP BY day, kind
),
duration_ranked AS (
  SELECT
    id,
    day,
    kind,
    test_time_seconds,
    ROW_NUMBER() OVER (
      PARTITION BY day, kind ORDER BY test_time_seconds, id
    ) AS low_rank,
    ROW_NUMBER() OVER (
      PARTITION BY day, kind ORDER BY test_time_seconds DESC, id DESC
    ) AS high_rank,
    COUNT(*) OVER (PARTITION BY day, kind) AS duration_count
  FROM dut_base
  WHERE kind IN ('MT','ST') AND test_time_seconds IS NOT NULL
),
duration_trimmed AS (
  SELECT
    day,
    kind,
    MAX(duration_count) AS valid_duration_rows,
    MAX(CAST(duration_count / 1000 AS INTEGER)) AS trimmed_rows_each_tail,
    AVG(CASE
      WHEN low_rank>CAST(duration_count / 1000 AS INTEGER)
        AND high_rank>CAST(duration_count / 1000 AS INTEGER)
      THEN test_time_seconds
    END) AS trimmed_mean_test_seconds
  FROM duration_ranked
  GROUP BY day, kind
),
dut_daily AS (
  SELECT
    q.day,
    q.kind,
    q.dut_rows,
    q.input_quantity,
    q.output_quantity,
    q.socket_quantity,
    q.touchdown_count,
    q.actual_test_seconds,
    t.valid_duration_rows,
    t.trimmed_rows_each_tail,
    t.trimmed_mean_test_seconds,
    CASE
      WHEN q.socket_quantity IS NULL OR q.socket_quantity=0 THEN NULL
      ELSE q.input_quantity / q.socket_quantity
    END AS dut_on,
    CASE
      WHEN q.actual_test_seconds IS NULL OR q.actual_test_seconds=0
        OR q.touchdown_count IS NULL OR t.trimmed_mean_test_seconds IS NULL THEN NULL
      ELSE t.trimmed_mean_test_seconds * q.touchdown_count / q.actual_test_seconds
    END AS test_time_performance,
    CASE
      WHEN q.input_quantity IS NULL OR q.input_quantity=0 THEN NULL
      ELSE q.output_quantity / q.input_quantity
    END AS final_yield
  FROM dut_daily_aggregate AS q
  LEFT JOIN duration_trimmed AS t ON t.day=q.day AND t.kind=q.kind
),
daily_results AS (
  SELECT
    a.day,
    a.kind,
    a.availability_rows,
    a.machine_count,
    a.machine_running_seconds,
    a.available_seconds,
    d.dut_rows,
    d.input_quantity,
    d.output_quantity,
    d.socket_quantity,
    d.touchdown_count,
    d.actual_test_seconds,
    d.valid_duration_rows,
    d.trimmed_rows_each_tail,
    d.trimmed_mean_test_seconds,
    a.availability,
    d.dut_on,
    d.test_time_performance,
    d.final_yield,
    CASE
      WHEN a.availability IS NULL OR d.dut_on IS NULL
        OR d.test_time_performance IS NULL OR d.final_yield IS NULL THEN NULL
      ELSE a.availability * d.dut_on * d.test_time_performance * d.final_yield
    END AS daily_test_oee
  FROM availability_daily AS a
  LEFT JOIN dut_daily AS d ON d.day=a.day AND d.kind=a.kind
)
SELECT
  c.day,
  k.kind,
  COALESCE(r.availability_rows,0) AS availability_rows,
  COALESCE(r.machine_count,0) AS machine_count,
  r.machine_running_seconds,
  r.available_seconds,
  r.dut_rows,
  r.input_quantity,
  r.output_quantity,
  r.socket_quantity,
  r.touchdown_count,
  r.actual_test_seconds,
  r.valid_duration_rows,
  r.trimmed_rows_each_tail,
  r.trimmed_mean_test_seconds,
  r.availability,
  r.dut_on,
  r.test_time_performance,
  r.final_yield,
  r.daily_test_oee,
  COUNT(r.daily_test_oee) OVER (PARTITION BY k.kind) AS calculable_day_count,
  COUNT(*) OVER (PARTITION BY k.kind) AS selected_day_count,
  AVG(r.daily_test_oee) OVER (PARTITION BY k.kind) AS period_test_oee
FROM calendar AS c
CROSS JOIN kinds AS k
LEFT JOIN daily_results AS r ON r.day=c.day AND r.kind=k.kind
ORDER BY c.day, k.kind`;

  return {
    startDate,
    endDate,
    exclusiveEndDate: availability.exclusiveEndDate,
    dailyGrain: ["day", "kind"],
    trimPercent: TEST_TIME_TRIM_PERCENT,
    trimFraction: TEST_TIME_TRIM_FRACTION,
    trimPercentPerTail: TEST_TIME_TRIM_PERCENT_PER_TAIL,
    trimFractionPerTail: TEST_TIME_TRIM_FRACTION_PER_TAIL,
    periodAggregation: "average_of_daily_oee",
    sql,
  };
}

/**
 * Project the canonical daily query into the exact row shapes used by Dashboard widgets.
 * Percentage columns deliberately contain percentage points (for example 56.65), because
 * Dashboard's `%` unit is a display suffix and does not scale ratios automatically.
 */
export function getDefaultTestOeeDashboardSql(
  startDate: string,
  endDate: string,
  view: TestOeeDashboardView,
): DefaultTestOeeDashboardSql {
  const daily = getDefaultTestOeeSql(startDate, endDate);
  const dailySubquery = `(\n${daily.sql}\n) AS daily`;
  const sql = view === "overview"
    ? `SELECT
  100.0 * AVG(daily_test_oee) AS overall_oee_percent,
  100.0 * AVG(CASE WHEN kind='MT' THEN daily_test_oee END) AS mt_oee_percent,
  100.0 * AVG(CASE WHEN kind='ST' THEN daily_test_oee END) AS st_oee_percent,
  100.0 * AVG(CASE WHEN daily_test_oee IS NOT NULL THEN availability END)
    AS avg_availability_percent,
  100.0 * AVG(CASE WHEN daily_test_oee IS NOT NULL THEN dut_on END)
    AS avg_dut_on_percent,
  100.0 * AVG(CASE WHEN daily_test_oee IS NOT NULL THEN test_time_performance END)
    AS avg_test_time_percent,
  100.0 * AVG(CASE WHEN daily_test_oee IS NOT NULL THEN final_yield END)
    AS avg_yield_percent,
  COUNT(daily_test_oee) AS calculable_day_type_count,
  COUNT(*) AS selected_day_type_count,
  SUM(CASE WHEN availability_rows>0 THEN 1 ELSE 0 END) AS availability_day_type_count,
  COUNT(dut_rows) AS dut_day_type_count
FROM ${dailySubquery}`
    : `SELECT
  day,
  100.0 * MAX(CASE WHEN kind='MT' THEN availability END) AS mt_availability_percent,
  100.0 * MAX(CASE WHEN kind='ST' THEN availability END) AS st_availability_percent,
  100.0 * MAX(CASE WHEN kind='MT' THEN dut_on END) AS mt_dut_on_percent,
  100.0 * MAX(CASE WHEN kind='ST' THEN dut_on END) AS st_dut_on_percent,
  100.0 * MAX(CASE WHEN kind='MT' THEN test_time_performance END) AS mt_test_time_percent,
  100.0 * MAX(CASE WHEN kind='ST' THEN test_time_performance END) AS st_test_time_percent,
  100.0 * MAX(CASE WHEN kind='MT' THEN final_yield END) AS mt_yield_percent,
  100.0 * MAX(CASE WHEN kind='ST' THEN final_yield END) AS st_yield_percent,
  100.0 * MAX(CASE WHEN kind='MT' THEN daily_test_oee END) AS mt_oee_percent,
  100.0 * MAX(CASE WHEN kind='ST' THEN daily_test_oee END) AS st_oee_percent
FROM ${dailySubquery}
GROUP BY day
ORDER BY day`;

  return {
    startDate,
    endDate,
    view,
    valueScale: "percentage_points",
    sql,
  };
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
