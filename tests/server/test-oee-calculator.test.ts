import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import {
  calculateRatioProduct,
  classifyAvailabilityState,
  classifyAvailabilityStates,
  classifyTestOeeKind,
  classifyTestOeeKinds,
  getDefaultTestOeeDashboardSql,
  getDefaultTestOeeSql,
  getTestOeeSqlExpressions,
  isExcludedPciePlatformMachine,
  isValidOeeLotId,
  MAX_RULE_BATCH_SIZE,
  PCIE_PLATFORM_MACHINE_IDS,
  TestOeeInputError,
  validateTestOeeLotIds,
} from "../../src/server/skills/test-oee-calculator/assets/test-oee-calculator.ts";
import { createTools } from "../../src/server/skills/test-oee-calculator/assets/tools.ts";

interface CallableSkillTool {
  readonly name: string;
  execute(
    id: string,
    params: Record<string, unknown>,
    signal: AbortSignal | undefined,
    onUpdate: undefined,
    context: never,
  ): Promise<{ readonly content: readonly { readonly type: string; readonly text?: string }[] }>;
}

async function executeTool(
  tool: CallableSkillTool,
  params: Record<string, unknown>,
): Promise<unknown> {
  const result = await tool.execute(
    "test",
    params,
    undefined,
    undefined,
    undefined as never,
  );
  return JSON.parse(result.content[0]?.text ?? "null") as unknown;
}

test("validates LOT_ID values with the fixed prefix rule", () => {
  assert.equal(isValidOeeLotId("P123"), true);
  assert.equal(isValidOeeLotId("L123"), true);
  assert.equal(isValidOeeLotId("None"), false);
  assert.equal(isValidOeeLotId("p123"), false);
  assert.deepEqual(validateTestOeeLotIds(["P123", "X123", ""]), [
    { lotId: "P123", eligibleLot: true },
    { lotId: "X123", eligibleLot: false },
    { lotId: "", eligibleLot: false },
  ]);
  assert.throws(() => validateTestOeeLotIds([]), TestOeeInputError);
  assert.throws(
    () => validateTestOeeLotIds(Array.from({ length: MAX_RULE_BATCH_SIZE + 1 }, () => "P1")),
    TestOeeInputError,
  );
});

test("classifies MT/ST with step precedence and platform fallback", () => {
  assert.equal(classifyTestOeeKind("5000", "ADH092"), "MT");
  assert.equal(classifyTestOeeKind("9500", "ADH001"), "MT");
  assert.equal(classifyTestOeeKind("7000", "ADH001"), "ST");
  assert.equal(classifyTestOeeKind("9700", "ADH001"), "ST");
  assert.equal(classifyTestOeeKind("1000", "ADH092"), "ST");
  assert.equal(classifyTestOeeKind("1000", "ADH001"), null);
  assert.deepEqual(classifyTestOeeKinds([
    { step: "5000", machineId: "ADH092" },
    { step: "1000", machineId: "TSPH001" },
    { step: "1000", machineId: "ADH001" },
  ]), [
    {
      step: "5000",
      machineId: "ADH092",
      kind: "MT",
      source: "step",
      excludedPciePlatform: false,
      includedInOee: true,
    },
    {
      step: "1000",
      machineId: "TSPH001",
      kind: "ST",
      source: "platform",
      excludedPciePlatform: true,
      includedInOee: false,
    },
    {
      step: "1000",
      machineId: "ADH001",
      kind: null,
      source: null,
      excludedPciePlatform: false,
      includedInOee: false,
    },
  ]);
});

test("excludes every machine whose configured platform contains PCIe", () => {
  assert.equal(PCIE_PLATFORM_MACHINE_IDS.length, 13);
  assert.equal(new Set(PCIE_PLATFORM_MACHINE_IDS).size, 13);
  for (let index = 1; index <= 13; index += 1) {
    const machineId = `TSPH${String(index).padStart(3, "0")}`;
    assert.equal(isExcludedPciePlatformMachine(machineId), true);
  }
  assert.equal(isExcludedPciePlatformMachine("ADH092"), false);
  assert.equal(isExcludedPciePlatformMachine("UNKNOWN"), false);
});

test("covers every Availability state classification branch", () => {
  const cases: readonly (readonly [string, string, string])[] = [
    ["Assistance", "P1", "Assistance"],
    ["Assistance", "None", "IDLE"],
    ["Conversion", "P1", "Conversion"],
    ["HangUp", "P1", "HangUp"],
    ["HangUp", "None", "IDLE"],
    ["PM", "P1", "PM"],
    ["Handler_Flush", "P1", "Handler_Flush"],
    ["IDLE_NoWIP", "P1", "IDLE_NoWIP"],
    ["IDLE_WaitARV", "P1", "IDLE_WaitARV"],
    ["IDLE", "P1", "IDLE"],
    ["IDLE_NoWIP(NoTask)", "P1", "IDLE_NoWIP"],
    ["IDLE_NoTask(xCurrentLot)", "P1", "IDLE_NoWIP"],
    ["IDLE_NoTask(xAllBundleReachable)", "P1", "IDLE_NoTask"],
    ["IDLE_NoTask(xUnknown)", "P1", "IDLE_NoTask"],
    ["HANDLER_PAUSE(Golden)", "P1", "Golden_run_time"],
    ["Handler_Executing(Golden)", "P1", "Golden_run_time"],
    ["Loader_Unload(Golden)", "P1", "Golden_run_time"],
    ["Machine_Initialize(Golden)", "P1", "Golden_run_time"],
    ["Temp_Down(Golden)", "P1", "Golden_run_time"],
    ["Temp_Up(Golden)", "P1", "Golden_run_time"],
    ["Test(Golden)", "P1", "Golden_run_time"],
    ["Not_Defined", "P1", "Not_Defined"],
    ["Temp_Up(Normal Retest)", "None", "Other"],
    ["Temp_Up(Normal Retest)", "P1", "Machine_Running"],
    ["Retest(Golden)", "P1", "Machine_Running"],
    ["RMS_Initialize(Golden)", "P1", "Machine_Running"],
    ["Test(Golden Retest)", "P1", "Machine_Running"],
    ["Test(Normal)", "P1", "Machine_Running"],
  ];
  for (const [finalState, lotId, expected] of cases) {
    assert.equal(classifyAvailabilityState(finalState, lotId), expected);
  }
  const results = classifyAvailabilityStates(cases.map(([finalState, lotId]) => ({
    finalState,
    lotId,
  })));
  assert.equal(results.at(-1)?.stateGroup, "Machine_Running");
  assert.equal(results.at(-1)?.machineRunning, true);
  assert.equal(results[0]?.machineRunning, false);
});

test("generates SQL expressions equivalent to the value classifiers", () => {
  const database = new DatabaseSync(":memory:");
  database.exec(`CREATE TABLE availability_rows (
    id INTEGER PRIMARY KEY,
    lot_id TEXT NOT NULL,
    step TEXT NOT NULL,
    tool_name TEXT NOT NULL,
    final_state TEXT NOT NULL
  );
  CREATE TABLE dut_rows (
    id INTEGER PRIMARY KEY,
    lot_id TEXT NOT NULL,
    step_id TEXT NOT NULL,
    machine_id TEXT NOT NULL
  );`);
  const availabilityCases = [
    { lotId: "P1", step: "5000", machineId: "ADH092", finalState: "Test(Normal)" },
    { lotId: "X1", step: "9700", machineId: "ADH001", finalState: "Assistance" },
    { lotId: "M1", step: "1000", machineId: "ADH092", finalState: "Test(Golden)" },
    { lotId: "R1", step: "1000", machineId: "ADH001", finalState: "IDLE" },
  ];
  const insertAvailability = database.prepare(
    "INSERT INTO availability_rows (lot_id,step,tool_name,final_state) VALUES(?,?,?,?)",
  );
  for (const row of availabilityCases) {
    insertAvailability.run(row.lotId, row.step, row.machineId, row.finalState);
  }
  const availability = getTestOeeSqlExpressions(
    "availability",
    "2026-08-31",
    "2026-09-06",
    "a",
  );
  assert.ok(availability.availabilityStateExpression);
  assert.equal(availability.exclusiveEndDate, "2026-09-07");
  assert.equal(
    availability.dateRangePredicate,
    "substr(a.date,1,10)>='2026-08-31' AND substr(a.date,1,10)<'2026-09-07'",
  );
  assert.match(availability.platformPredicate, /a\.tool_name NOT IN/u);
  assert.match(availability.platformPredicate, /'TSPH001'/u);
  assert.match(availability.platformPredicate, /'TSPH013'/u);
  const availabilityRows = database.prepare(`SELECT
    ${availability.lotPredicate} AS eligible_lot,
    ${availability.kindExpression} AS kind,
    ${availability.availabilityStateExpression} AS state_group
    FROM availability_rows AS a ORDER BY a.id`).all() as Record<string, unknown>[];
  availabilityRows.forEach((row, index) => {
    const source = availabilityCases[index]!;
    assert.equal(row["eligible_lot"] === 1, isValidOeeLotId(source.lotId));
    assert.equal(row["kind"], classifyTestOeeKind(source.step, source.machineId));
    assert.equal(row["state_group"], classifyAvailabilityState(source.finalState, source.lotId));
  });

  const dutCases = [
    { lotId: "F1", step: "9500", machineId: "ADH001" },
    { lotId: "L1", step: "1000", machineId: "ADH092" },
  ];
  const insertDut = database.prepare(
    "INSERT INTO dut_rows (lot_id,step_id,machine_id) VALUES(?,?,?)",
  );
  for (const row of dutCases) insertDut.run(row.lotId, row.step, row.machineId);
  const dut = getTestOeeSqlExpressions("dut", "2026-08-31", "2026-09-06", "d");
  assert.equal(dut.availabilityStateExpression, undefined);
  assert.equal(dut.dayExpression, "substr(d.date,1,10)");
  assert.equal(dut.machineExpression, "d.machine_id");
  assert.match(dut.platformPredicate, /d\.machine_id NOT IN/u);
  assert.match(dut.touchdownLabelExpression ?? "", /d\.touchdown_index/u);
  assert.match(dut.testTimeSecondsExpression ?? "", /unixepoch\(d\.end_time,'subsec'\)/u);
  const dutRows = database.prepare(`SELECT
    ${dut.lotPredicate} AS eligible_lot,
    ${dut.kindExpression} AS kind
    FROM dut_rows AS d ORDER BY d.id`).all() as Record<string, unknown>[];
  dutRows.forEach((row, index) => {
    const source = dutCases[index]!;
    assert.equal(row["eligible_lot"], 1);
    assert.equal(row["kind"], classifyTestOeeKind(source.step, source.machineId));
  });
  database.close();

  assert.throws(
    () => getTestOeeSqlExpressions(
      "availability",
      "2026-08-31",
      "2026-09-06",
      "a;DROP_TABLE",
    ),
    /合法的 SQL 标识符/u,
  );
  assert.throws(
    () => getTestOeeSqlExpressions("availability", "2026-02-30", "2026-03-01"),
    /有效的自然日/u,
  );
  assert.throws(
    () => getTestOeeSqlExpressions("availability", "2026-09-07", "2026-09-06"),
    /不能晚于/u,
  );
});

test("generated date predicate includes the complete end date", () => {
  const database = new DatabaseSync(":memory:");
  database.exec(`CREATE TABLE rows (date TEXT NOT NULL);
    INSERT INTO rows(date) VALUES
      ('2026-08-30T23:59:59.999Z'),
      ('2026-08-31T00:00:00.000Z'),
      ('2026-09-06T00:00:00.000Z'),
      ('2026-09-06T23:59:59.999Z'),
      ('2026-09-07T00:00:00.000Z');`);
  const expression = getTestOeeSqlExpressions(
    "availability",
    "2026-08-31",
    "2026-09-06",
  );
  const dates = database.prepare(
    `SELECT date FROM rows WHERE ${expression.dateRangePredicate} ORDER BY date`,
  ).all().map((row) => ({ date: row["date"] }));
  assert.deepEqual(dates, [
    { date: "2026-08-31T00:00:00.000Z" },
    { date: "2026-09-06T00:00:00.000Z" },
    { date: "2026-09-06T23:59:59.999Z" },
  ]);
  database.close();
});

test("generates DUT expressions for valid touchdown labels and timestamp durations", () => {
  const database = new DatabaseSync(":memory:");
  database.exec(`CREATE TABLE dut_rows (
    id INTEGER PRIMARY KEY,
    touchdown_index TEXT,
    start_time TEXT,
    end_time TEXT
  );
  INSERT INTO dut_rows(touchdown_index,start_time,end_time) VALUES
    ('12','2026-01-01T00:00:00.000Z','2026-01-01T00:00:05.500Z'),
    ('0','2026-01-01T00:00:00.000Z','2026-01-01T00:00:07.000Z'),
    ('12x','invalid','2026-01-01T00:00:07.000Z'),
    (NULL,NULL,NULL);`);
  const expressions = getTestOeeSqlExpressions("dut", "2026-01-01", "2026-01-01", "d");
  const rows = database.prepare(`SELECT
    ${expressions.touchdownLabelExpression} AS touchdown_label,
    ${expressions.testTimeSecondsExpression} AS test_time_seconds
    FROM dut_rows AS d ORDER BY d.id`).all();
  assert.deepEqual(rows.map((row) => ({
    touchdownLabel: row["touchdown_label"],
    testTimeSeconds: row["test_time_seconds"],
  })), [
    { touchdownLabel: 1, testTimeSeconds: 5.5 },
    { touchdownLabel: null, testTimeSeconds: 7 },
    { touchdownLabel: null, testTimeSeconds: null },
    { touchdownLabel: null, testTimeSeconds: null },
  ]);
  database.close();
});

test("default SQL aggregates components by day and kind, then averages daily OEE", () => {
  const database = new DatabaseSync(":memory:");
  database.exec(`CREATE TABLE oee_availability (
    id INTEGER PRIMARY KEY,
    tool_name TEXT NOT NULL,
    lot_id TEXT NOT NULL,
    final_state TEXT NOT NULL,
    step TEXT NOT NULL,
    date TEXT NOT NULL,
    time_span INTEGER NOT NULL
  );
  CREATE TABLE oee_dut_utilization (
    id INTEGER PRIMARY KEY,
    machine_id TEXT NOT NULL,
    lot_id TEXT NOT NULL,
    touchdown_index TEXT,
    start_time TEXT,
    end_time TEXT,
    in_qty TEXT NOT NULL,
    out_qty TEXT NOT NULL,
    dut_num TEXT NOT NULL,
    step_id TEXT NOT NULL,
    date TEXT
  );`);
  const insertAvailability = database.prepare(
    "INSERT INTO oee_availability(tool_name,lot_id,final_state,step,date,time_span) VALUES(?,?,?,?,?,?)",
  );
  const day1 = "2026-01-01T00:00:00.000Z";
  const day2 = "2026-01-02T00:00:00.000Z";
  insertAvailability.run("ADH001", "P1", "Test(Normal)", "5000", day1, 43_200);
  insertAvailability.run("ADH001", "P1", "IDLE", "5000", day1, 43_200);
  insertAvailability.run("ADH002", "P2", "Test(Normal)", "5000", day1, 86_400);
  insertAvailability.run("ADH003", "P3", "Test(Normal)", "5000", day1, 86_400);
  insertAvailability.run("ADH001", "P1", "Test(Normal)", "5000", day2, 86_400);
  insertAvailability.run("TSPH001", "P4", "Test(Normal)", "5000", day1, 86_400);

  const insertDut = database.prepare(
    "INSERT INTO oee_dut_utilization(machine_id,lot_id,touchdown_index,start_time,end_time,in_qty,out_qty,dut_num,step_id,date) VALUES(?,?,?,?,?,?,?,?,?,?)",
  );
  const addDut = (machine: string, day: string, durationSeconds: number, index: number): void => {
    const start = `${day}T00:00:00.000Z`;
    const end = new Date(Date.parse(start) + durationSeconds * 1_000).toISOString();
    insertDut.run(machine, "P1", String(index), start, end, "10", "8", "20", "5000", `${day}T00:00:00.000Z`);
  };
  const day1Durations = [1, ...Array.from({ length: 998 }, () => 10), 100];
  day1Durations.forEach((duration, index) => {
    addDut(index < 500 ? "ADH001" : "ADH004", "2026-01-01", duration, index + 1);
  });
  addDut("ADH001", "2026-01-02", 10, 1);
  addDut("TSPH001", "2026-01-01", 10_000, 1);

  const generated = getDefaultTestOeeSql("2026-01-01", "2026-01-02");
  assert.deepEqual(generated.dailyGrain, ["day", "kind"]);
  assert.equal(generated.trimPercent, 0.2);
  assert.equal(generated.trimFraction, 0.002);
  assert.equal(generated.trimPercentPerTail, 0.1);
  assert.equal(generated.trimFractionPerTail, 0.001);
  assert.equal(generated.periodAggregation, "average_of_daily_oee");
  const rows = database.prepare(generated.sql).all();
  assert.equal(rows.length, 4);
  const day1Mt = rows.find((row) => row["day"] === "2026-01-01" && row["kind"] === "MT");
  const day2Mt = rows.find((row) => row["day"] === "2026-01-02" && row["kind"] === "MT");
  const day1St = rows.find((row) => row["day"] === "2026-01-01" && row["kind"] === "ST");
  assert.ok(day1Mt);
  assert.ok(day2Mt);
  assert.ok(day1St);
  assert.equal(day1Mt["availability_rows"], 4);
  assert.equal(day1Mt["machine_count"], 3);
  assert.equal(day1Mt["machine_running_seconds"], 216_000);
  assert.equal(day1Mt["available_seconds"], 259_200);
  assert.ok(Math.abs(Number(day1Mt["availability"]) - 5 / 6) < 1e-12);
  assert.equal(day1Mt["dut_rows"], 1_000);
  assert.equal(day1Mt["valid_duration_rows"], 1_000);
  assert.equal(day1Mt["trimmed_rows_each_tail"], 1);
  assert.equal(day1Mt["trimmed_mean_test_seconds"], 10);
  assert.ok(Math.abs(Number(day1Mt["test_time_performance"]) - 10_000 / 10_081) < 1e-12);
  assert.ok(Math.abs(Number(day1Mt["daily_test_oee"]) - 10_000 / 30_243) < 1e-12);
  assert.ok(Math.abs(Number(day2Mt["daily_test_oee"]) - 0.4) < 1e-12);
  assert.equal(day1Mt["calculable_day_count"], 2);
  assert.equal(day1Mt["selected_day_count"], 2);
  const expectedPeriodOee = (10_000 / 30_243 + 0.4) / 2;
  assert.ok(Math.abs(Number(day1Mt["period_test_oee"]) - expectedPeriodOee) < 1e-12);
  assert.equal(day1St["availability_rows"], 0);
  assert.equal(day1St["machine_count"], 0);
  assert.equal(day1St["daily_test_oee"], null);
  assert.equal(day1St["calculable_day_count"], 0);
  assert.equal(day1St["period_test_oee"], null);

  const overview = database.prepare(
    getDefaultTestOeeDashboardSql("2026-01-01", "2026-01-02", "overview").sql,
  ).get();
  assert.ok(overview);
  assert.ok(
    Math.abs(Number(overview["overall_oee_percent"]) - expectedPeriodOee * 100) < 1e-10,
  );
  assert.ok(Math.abs(Number(overview["mt_oee_percent"]) - expectedPeriodOee * 100) < 1e-10);
  assert.equal(overview["st_oee_percent"], null);
  assert.equal(overview["calculable_day_type_count"], 2);
  assert.equal(overview["selected_day_type_count"], 4);
  assert.equal(overview["availability_day_type_count"], 2);
  assert.equal(overview["dut_day_type_count"], 2);

  const trends = database.prepare(
    getDefaultTestOeeDashboardSql("2026-01-01", "2026-01-02", "trends").sql,
  ).all();
  assert.equal(trends.length, 2);
  assert.ok(Math.abs(Number(trends[0]?.["mt_availability_percent"]) - (5 / 6) * 100) < 1e-10);
  assert.equal(trends[0]?.["st_availability_percent"], null);
  assert.ok(
    Math.abs(Number(trends[0]?.["mt_oee_percent"]) - Number(day1Mt["daily_test_oee"]) * 100) <
      1e-10,
  );
  database.close();
});

test("calculates configurable ratios and products without rounding or repair", () => {
  const result = calculateRatioProduct({
    ratios: [
      { name: "Availability", numerator: 50, denominator: 100 },
      { name: "DUT-On", numerator: 80, denominator: 100 },
      { name: "Yield", numerator: 90, denominator: 100 },
      { name: "Diagnostic", numerator: 1, denominator: 0, includeInProduct: false },
    ],
    factors: [{ name: "Performance", value: 1 }],
  });
  assert.equal(result.ratios[0]?.value, 0.5);
  assert.equal(result.ratios[0]?.percent, 50);
  assert.equal(result.ratios[3]?.value, null);
  assert.equal(result.product, 0.5 * 0.8 * 0.9);
  assert.equal(result.productPercent, 0.5 * 0.8 * 0.9 * 100);

  const unrounded = calculateRatioProduct({
    ratios: [{ name: "one-third", numerator: 1, denominator: 3 }],
  });
  assert.equal(unrounded.product, 1 / 3);
  const undefinedProduct = calculateRatioProduct({
    ratios: [{ name: "undefined", numerator: 1, denominator: 0 }],
  });
  assert.equal(undefinedProduct.product, null);
  assert.equal(undefinedProduct.productPercent, null);
  const negative = calculateRatioProduct({
    ratios: [{ name: "negative", numerator: -5, denominator: 10 }],
  });
  assert.equal(negative.product, -0.5);
  assert.equal(negative.productPercent, -50);
  assert.throws(
    () => calculateRatioProduct({
      ratios: [{ name: "same", numerator: 1, denominator: 2 }],
      factors: [{ name: "same", value: 1 }],
    }),
    /不能重复/u,
  );
  assert.throws(
    () => calculateRatioProduct({
      ratios: [{ name: "excluded", numerator: 1, denominator: 2, includeInProduct: false }],
    }),
    /至少要有一个/u,
  );
});

test("matches the SQL ratio and product semantics used for database-derived OEE", () => {
  const source = {
    availabilityNumerator: 50,
    availabilityDenominator: 100,
    dutOnNumerator: 80,
    dutOnDenominator: 100,
    yieldNumerator: 90,
    yieldDenominator: 100,
  };
  const expected = calculateRatioProduct({
    ratios: [
      {
        name: "Availability",
        numerator: source.availabilityNumerator,
        denominator: source.availabilityDenominator,
      },
      {
        name: "DUT-On",
        numerator: source.dutOnNumerator,
        denominator: source.dutOnDenominator,
      },
      {
        name: "Yield",
        numerator: source.yieldNumerator,
        denominator: source.yieldDenominator,
      },
    ],
  });
  const database = new DatabaseSync(":memory:");
  const actual = database.prepare(`SELECT
    CASE WHEN ? = 0 THEN NULL ELSE CAST(? AS REAL) / ? END AS availability,
    CASE WHEN ? = 0 THEN NULL ELSE CAST(? AS REAL) / ? END AS dut_on,
    CASE WHEN ? = 0 THEN NULL ELSE CAST(? AS REAL) / ? END AS yield,
    CASE WHEN ? = 0 OR ? = 0 OR ? = 0 THEN NULL ELSE
      (CAST(? AS REAL) / ?) * (CAST(? AS REAL) / ?) * (CAST(? AS REAL) / ?)
    END AS product`).get(
    source.availabilityDenominator,
    source.availabilityNumerator,
    source.availabilityDenominator,
    source.dutOnDenominator,
    source.dutOnNumerator,
    source.dutOnDenominator,
    source.yieldDenominator,
    source.yieldNumerator,
    source.yieldDenominator,
    source.availabilityDenominator,
    source.dutOnDenominator,
    source.yieldDenominator,
    source.availabilityNumerator,
    source.availabilityDenominator,
    source.dutOnNumerator,
    source.dutOnDenominator,
    source.yieldNumerator,
    source.yieldDenominator,
  );
  database.close();
  assert.ok(actual);
  assert.equal(actual["availability"], expected.ratios[0]?.value);
  assert.equal(actual["dut_on"], expected.ratios[1]?.value);
  assert.equal(actual["yield"], expected.ratios[2]?.value);
  assert.equal(actual["product"], expected.product);
});

test("publishes deterministic database-free Skill tools", async () => {
  const tools = createTools() as readonly CallableSkillTool[];
  assert.deepEqual(tools.map((tool) => tool.name), [
    "get_default_sql",
    "get_default_dashboard_sql",
    "get_sql_expressions",
    "validate_lot_ids",
    "classify_mt_st",
    "classify_availability_states",
  ]);
  assert.equal(tools.some((tool) => tool.name === "calculate_test_oee"), false);
  assert.equal(tools.some((tool) => tool.name === "classify_test_oee_record"), false);

  const byName = new Map(tools.map((tool) => [tool.name, tool]));
  const defaultSql = await executeTool(byName.get("get_default_sql")!, {
    start_date: "2026-08-31",
    end_date: "2026-09-06",
  }) as {
    sql: string;
    dailyGrain: readonly string[];
    trimPercent: number;
    trimFraction: number;
    periodAggregation: string;
  };
  assert.match(defaultSql.sql, /LEFT JOIN dut_daily AS d ON d\.day=a\.day AND d\.kind=a\.kind/u);
  assert.match(defaultSql.sql, /duration_count \/ 1000/u);
  assert.match(defaultSql.sql, /AVG\(r\.daily_test_oee\) OVER/u);
  assert.deepEqual(defaultSql.dailyGrain, ["day", "kind"]);
  assert.equal(defaultSql.trimPercent, 0.2);
  assert.equal(defaultSql.trimFraction, 0.002);
  assert.equal(defaultSql.periodAggregation, "average_of_daily_oee");
  const dashboardSql = await executeTool(byName.get("get_default_dashboard_sql")!, {
    start_date: "2026-08-31",
    end_date: "2026-09-06",
    view: "overview",
  }) as { sql: string; valueScale: string; view: string };
  assert.equal(dashboardSql.view, "overview");
  assert.equal(dashboardSql.valueScale, "percentage_points");
  assert.match(dashboardSql.sql, /100\.0 \* AVG\(daily_test_oee\) AS overall_oee_percent/u);
  assert.match(dashboardSql.sql, /COUNT\(\*\) AS selected_day_type_count/u);
  const sqlExpressions = await executeTool(byName.get("get_sql_expressions")!, {
    source: "dut",
    start_date: "2026-08-31",
    end_date: "2026-09-06",
    table_alias: "d",
  }) as { kindExpression: string; dateRangePredicate: string };
  assert.match(sqlExpressions.kindExpression, /d\.step_id/u);
  assert.match(sqlExpressions.dateRangePredicate, /substr\(d\.date,1,10\)/u);
  assert.deepEqual(await executeTool(byName.get("validate_lot_ids")!, {
    lot_ids: ["P1", "X1"],
  }), [
    { lotId: "P1", eligibleLot: true },
    { lotId: "X1", eligibleLot: false },
  ]);
  assert.deepEqual(await executeTool(byName.get("classify_mt_st")!, {
    records: [{ step: "1000", machine_id: "TSPH001" }],
  }), [
    {
      step: "1000",
      machineId: "TSPH001",
      kind: "ST",
      source: "platform",
      excludedPciePlatform: true,
      includedInOee: false,
    },
  ]);
  assert.deepEqual(await executeTool(byName.get("classify_availability_states")!, {
    records: [{ final_state: "Test(Normal)", lot_id: "P1" }],
  }), [
    {
      finalState: "Test(Normal)",
      lotId: "P1",
      stateGroup: "Machine_Running",
      machineRunning: true,
    },
  ]);
  assert.equal(byName.has("calculate_ratio_product"), false);
});

test("contains no Skill-owned database adapter or CLI", () => {
  const skillDirectory = path.resolve("src/server/skills/test-oee-calculator");
  assert.equal(existsSync(path.join(skillDirectory, "assets", "database.ts")), false);
  assert.equal(
    existsSync(path.join(skillDirectory, "scripts", "calculate-test-oee.ts")),
    false,
  );
  const implementation = [
    readFileSync(path.join(skillDirectory, "assets", "test-oee-calculator.ts"), "utf8"),
    readFileSync(path.join(skillDirectory, "assets", "tools.ts"), "utf8"),
  ].join("\n");
  assert.doesNotMatch(
    implementation,
    /AppDatabase|SQL_WEB_DB_PATH|withTestOeeDatabase|database\.query/u,
  );
});
