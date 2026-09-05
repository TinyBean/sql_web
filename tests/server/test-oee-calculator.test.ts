import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { initializeOeeDatabase } from "../../scripts/database/initialize.ts";
import { AppDatabase } from "../../src/server/data/database.ts";
import {
  resolveTestOeeDatabasePath,
  resolveTestOeeProjectRoot,
  withTestOeeDatabase,
} from "../../src/server/skills/test-oee-calculator/database.ts";
import {
  calculateTestOee,
  classifyAvailabilityState,
  classifyTestOeeKind,
  classifyTestOeeRecord,
  inclusiveCalendarDays,
  isValidOeeLotId,
  TestOeeInputError,
} from "../../src/server/skills/test-oee-calculator/test-oee-calculator.ts";
import { createTools } from "../../src/server/skills/test-oee-calculator/tools.ts";

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

test("classifies valid lots, MT/ST, and Machine_Running deterministically", () => {
  assert.equal(isValidOeeLotId("P123"), true);
  assert.equal(isValidOeeLotId("L123"), true);
  assert.equal(isValidOeeLotId("None"), false);
  assert.equal(isValidOeeLotId("p123"), false);

  assert.equal(classifyTestOeeKind("5000", "ADH092"), "MT");
  assert.equal(classifyTestOeeKind("9500", "ADH001"), "MT");
  assert.equal(classifyTestOeeKind("7000", "ADH001"), "ST");
  assert.equal(classifyTestOeeKind("9700", "ADH001"), "ST");
  assert.equal(classifyTestOeeKind("1000", "ADH092"), "ST");
  assert.equal(classifyTestOeeKind("1000", "ADH001"), null);

  assert.equal(classifyAvailabilityState("Assistance", "P123"), "Assistance");
  assert.equal(classifyAvailabilityState("Assistance", "None"), "IDLE");
  assert.equal(classifyAvailabilityState("IDLE_NoTask(xCurrentLot)", "P123"), "IDLE_NoWIP");
  assert.equal(classifyAvailabilityState("IDLE_NoTask(xUnknown)", "P123"), "IDLE_NoTask");
  assert.equal(classifyAvailabilityState("Test(Golden)", "P123"), "Golden_run_time");
  assert.equal(classifyAvailabilityState("Retest(Golden)", "P123"), "Machine_Running");
  assert.equal(
    classifyAvailabilityState("Temp_Up(Normal Retest)", "None"),
    "Other",
  );
  assert.equal(
    classifyAvailabilityState("Temp_Up(Normal Retest)", "P123"),
    "Machine_Running",
  );
  assert.deepEqual(classifyTestOeeRecord({
    lotId: "P123",
    step: "1000",
    machineId: "ADH092",
    finalState: "Retest(Golden)",
  }), {
    lotId: "P123",
    eligibleLot: true,
    step: "1000",
    machineId: "ADH092",
    kind: "ST",
    kindSource: "platform",
    includedInCalculation: true,
    availabilityState: "Machine_Running",
  });
});

test("validates and counts inclusive date ranges", () => {
  assert.equal(inclusiveCalendarDays("2026-08-21", "2026-08-21"), 1);
  assert.equal(inclusiveCalendarDays("2026-08-21", "2026-08-23"), 3);
  assert.throws(
    () => inclusiveCalendarDays("2026-02-30", "2026-03-01"),
    TestOeeInputError,
  );
  assert.throws(
    () => inclusiveCalendarDays("2026-08-22", "2026-08-21"),
    /不能早于/u,
  );
});

test("resolves Test OEE database paths from source and build locations", (t) => {
  const projectRoot = path.resolve(".");
  const sourceModuleDirectory = path.join(
    projectRoot,
    "src/server/skills/test-oee-calculator",
  );
  const buildModuleDirectory = path.join(
    projectRoot,
    "dist/src/server/skills/test-oee-calculator",
  );
  assert.equal(resolveTestOeeProjectRoot(sourceModuleDirectory), projectRoot);
  assert.equal(resolveTestOeeProjectRoot(buildModuleDirectory), projectRoot);

  const previousDatabasePath = process.env["SQL_WEB_DB_PATH"];
  t.after(() => {
    if (previousDatabasePath === undefined) delete process.env["SQL_WEB_DB_PATH"];
    else process.env["SQL_WEB_DB_PATH"] = previousDatabasePath;
  });
  process.env["SQL_WEB_DB_PATH"] = "from-environment.sqlite";
  assert.equal(
    resolveTestOeeDatabasePath(undefined, sourceModuleDirectory),
    path.join(projectRoot, "from-environment.sqlite"),
  );
  assert.equal(
    resolveTestOeeDatabasePath("from-override.sqlite", buildModuleDirectory),
    path.join(projectRoot, "from-override.sqlite"),
  );
  delete process.env["SQL_WEB_DB_PATH"];
  assert.equal(
    resolveTestOeeDatabasePath(undefined, buildModuleDirectory),
    path.join(projectRoot, ".data/database/oee.sqlite"),
  );
});

test("closes a Skill-owned database after its operation", (t) => {
  const directory = mkdtempSync(path.join(tmpdir(), "test-oee-database-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, "oee.sqlite");
  initializeOeeDatabase(filePath);

  let openedDatabase: AppDatabase | undefined;
  const schema = withTestOeeDatabase((database) => {
    openedDatabase = database;
    return database.getSchema();
  }, filePath);
  assert.ok(schema.length > 0);
  assert.ok(openedDatabase);
  assert.throws(() => openedDatabase!.getSchema(), /数据库尚未初始化/u);
});

test("calculates MT/ST Test OEE with all machines and all test stages", async (t) => {
  const directory = mkdtempSync(path.join(tmpdir(), "test-oee-calculator-"));
  const filePath = path.join(directory, "oee.sqlite");
  initializeOeeDatabase(filePath);
  const writer = new DatabaseSync(filePath);
  const insertAvailability = writer.prepare(
    `INSERT INTO oee_availability
      (tool_name,lot_id,final_state,step,date,shift,time_span)
     VALUES(?,?,?,?,?,?,?)`,
  );
  insertAvailability.run("MT1", "P1", "Test(Normal)", "5000", "2026-01-01", null, 100);
  insertAvailability.run("MT2", "P2", "IDLE", "5000", "2026-01-02", null, 100);
  insertAvailability.run("ADH092", "P3", "Test(Normal)", "1000", "2026-01-01", null, 200);
  insertAvailability.run("UNKNOWN", "P4", "Test(Normal)", "1000", "2026-01-01", null, 999);
  insertAvailability.run("INVALID", "X1", "Test(Normal)", "5000", "2026-01-01", null, 999);

  const insertDut = writer.prepare(
    `INSERT INTO oee_dut_utilization
      (machine_id,lot_id,in_qty,out_qty,test_stage,dut_num,step_id,date)
     VALUES(?,?,?,?,?,?,?,?)`,
  );
  insertDut.run("MT1", "P1", "100", "90", "1st", "200", "5000", "2026-01-01");
  insertDut.run("MT1", "P1", "10", "5", "Rescreen", "20", "5000", "2026-01-01");
  insertDut.run("ADH092", "P2", "50", "45", "1st", "100", "1000", "2026-01-01");
  insertDut.run("UNKNOWN", "P3", "99", "99", "1st", "100", "1000", "2026-01-01");
  insertDut.run("INVALID", "X1", "999", "999", "1st", "999", "5000", "2026-01-01");
  writer.close();

  const previousDatabasePath = process.env["SQL_WEB_DB_PATH"];
  const database = AppDatabase.open({ filePath });
  t.after(() => {
    database.close();
    if (previousDatabasePath === undefined) delete process.env["SQL_WEB_DB_PATH"];
    else process.env["SQL_WEB_DB_PATH"] = previousDatabasePath;
    rmSync(directory, { recursive: true, force: true });
  });
  const result = calculateTestOee(database, "2026-01-01", "2026-01-01");
  const mt = result.results.find((row) => row.kind === "MT");
  const st = result.results.find((row) => row.kind === "ST");
  assert.ok(mt);
  assert.ok(st);

  assert.equal(mt.machineCount, 2);
  assert.equal(mt.runningSeconds, 100);
  assert.equal(mt.availableSeconds, 2 * 86_400);
  assert.equal(mt.availability, 100 / (2 * 86_400));
  assert.equal(mt.inQty, 110);
  assert.equal(mt.outQty, 95);
  assert.equal(mt.dutNum, 220);
  assert.equal(mt.dutOn, 110 / 220);
  assert.equal(mt.yield, 95 / 110);
  assert.equal(mt.testOee, (100 / (2 * 86_400)) * (110 / 220) * (95 / 110));
  assert.deepEqual(mt.coverage, {
    availabilityRows: 1,
    availabilityDates: 1,
    dutRows: 2,
    dutDates: 1,
  });

  assert.equal(st.machineCount, 1);
  assert.equal(st.runningSeconds, 200);
  assert.equal(st.inQty, 50);
  assert.equal(st.outQty, 45);
  assert.equal(st.dutNum, 100);
  assert.equal(result.diagnostics.unclassifiedAvailabilityRows, 1);
  assert.equal(result.diagnostics.unclassifiedDutRows, 1);

  const mtOnly = calculateTestOee(database, "2026-01-01", "2026-01-01", "MT");
  assert.deepEqual(mtOnly.results.map((row) => row.kind), ["MT"]);

  process.env["SQL_WEB_DB_PATH"] = path.join(directory, "missing.sqlite");
  const tools = createTools() as readonly CallableSkillTool[];
  assert.deepEqual(tools.map((tool) => tool.name), [
    "calculate_test_oee",
    "classify_test_oee_record",
  ]);
  const calculateTool = tools.find((tool) => tool.name === "calculate_test_oee");
  const classifyTool = tools.find((tool) => tool.name === "classify_test_oee_record");
  assert.ok(calculateTool);
  assert.ok(classifyTool);
  const classified = await classifyTool.execute(
    "classify",
    { lot_id: "P123", step: "1000", machine_id: "ADH092", final_state: "Retest(Golden)" },
    undefined,
    undefined,
    undefined as never,
  );
  assert.equal(
    (JSON.parse(classified.content[0]?.text ?? "{}") as { kind?: string }).kind,
    "ST",
  );

  process.env["SQL_WEB_DB_PATH"] = filePath;
  const calculated = await calculateTool.execute(
    "calculate",
    { start_date: "2026-01-01", end_date: "2026-01-01", kind: "ST" },
    undefined,
    undefined,
    undefined as never,
  );
  assert.deepEqual(
    (JSON.parse(calculated.content[0]?.text ?? "{}") as { results?: { kind: string }[] }).results
      ?.map((row) => row.kind),
    ["ST"],
  );
  await assert.rejects(
    () => calculateTool.execute(
      "invalid",
      { start_date: "2026-99-99", end_date: "2026-01-01" },
      undefined,
      undefined,
      undefined as never,
    ),
    TestOeeInputError,
  );
});

test("runs the Skill-owned Test OEE CLI", (t) => {
  const directory = mkdtempSync(path.join(tmpdir(), "test-oee-cli-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, "oee.sqlite");
  initializeOeeDatabase(filePath);
  const scriptPath = path.resolve(
    "src/server/skills/test-oee-calculator/scripts/calculate-test-oee.ts",
  );
  const result = spawnSync(process.execPath, [
    "--import",
    "tsx",
    scriptPath,
    "2026-01-01",
    "2026-01-01",
    "MT",
    "--database",
    filePath,
  ], { cwd: process.cwd(), encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  const parsed = JSON.parse(result.stdout) as { results: { kind: string }[] };
  assert.deepEqual(parsed.results.map((row) => row.kind), ["MT"]);

  const fromEnvironment = spawnSync(process.execPath, [
    "--import",
    "tsx",
    scriptPath,
    "2026-01-01",
    "2026-01-01",
    "ST",
  ], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: { ...process.env, SQL_WEB_DB_PATH: filePath },
  });
  assert.equal(fromEnvironment.status, 0, fromEnvironment.stderr);
  const environmentParsed = JSON.parse(fromEnvironment.stdout) as {
    results: { kind: string }[];
  };
  assert.deepEqual(environmentParsed.results.map((row) => row.kind), ["ST"]);

  const invalid = spawnSync(process.execPath, ["--import", "tsx", scriptPath], {
    cwd: process.cwd(),
    encoding: "utf8",
  });
  assert.notEqual(invalid.status, 0);
  assert.match(invalid.stderr, /用法/u);
});
