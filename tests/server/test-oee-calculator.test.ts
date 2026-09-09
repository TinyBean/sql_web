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
  getTestOeeSqlExpressions,
  isValidOeeLotId,
  MAX_RULE_BATCH_SIZE,
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
    { step: "1000", machineId: "ADH092" },
    { step: "1000", machineId: "ADH001" },
  ]), [
    { step: "5000", machineId: "ADH092", kind: "MT", source: "step" },
    { step: "1000", machineId: "ADH092", kind: "ST", source: "platform" },
    { step: "1000", machineId: "ADH001", kind: null, source: null },
  ]);
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

test("publishes only composable database-free Skill tools", async () => {
  const tools = createTools() as readonly CallableSkillTool[];
  assert.deepEqual(tools.map((tool) => tool.name), [
    "get_sql_expressions",
    "validate_lot_ids",
    "classify_mt_st",
    "classify_availability_states",
  ]);
  assert.equal(tools.some((tool) => tool.name === "calculate_test_oee"), false);
  assert.equal(tools.some((tool) => tool.name === "classify_test_oee_record"), false);

  const byName = new Map(tools.map((tool) => [tool.name, tool]));
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
    records: [{ step: "1000", machine_id: "ADH092" }],
  }), [
    { step: "1000", machineId: "ADH092", kind: "ST", source: "platform" },
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
