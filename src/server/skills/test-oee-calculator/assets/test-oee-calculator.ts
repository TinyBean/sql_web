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
  readonly lotPredicate: string;
  readonly kindExpression: string;
  readonly availabilityStateExpression?: string;
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
const SQL_IDENTIFIER_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/u;
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
  return records.map((record) => ({
    ...record,
    ...classifyTestOeeKindWithSource(record.step, record.machineId),
  }));
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

function validLotSql(column: string): string {
  return `substr(${column},1,1) IN (${VALID_OEE_LOT_PREFIXES.map(quoteSqlLiteral).join(",")})`;
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
  tableAlias?: string,
): TestOeeSqlExpressions {
  if (tableAlias !== undefined && !SQL_IDENTIFIER_PATTERN.test(tableAlias)) {
    throw new TestOeeInputError("table_alias 必须是合法的 SQL 标识符");
  }
  const lotIdColumn = sqlColumn("lot_id", tableAlias);
  if (source === "availability") {
    return {
      source,
      tableAlias: tableAlias ?? null,
      lotPredicate: validLotSql(lotIdColumn),
      kindExpression: kindSql(
        sqlColumn("step", tableAlias),
        sqlColumn("tool_name", tableAlias),
      ),
      availabilityStateExpression: availabilityStateSql(
        sqlColumn("final_state", tableAlias),
        lotIdColumn,
      ),
    };
  }
  return {
    source,
    tableAlias: tableAlias ?? null,
    lotPredicate: validLotSql(lotIdColumn),
    kindExpression: kindSql(
      sqlColumn("step_id", tableAlias),
      sqlColumn("machine_id", tableAlias),
    ),
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
