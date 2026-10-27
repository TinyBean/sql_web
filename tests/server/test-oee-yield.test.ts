import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import test, { type TestContext } from "node:test";
import {
  getDefaultTestOeeDashboardSql, getDefaultTestOeeSql, getMachinePeriodTestOeeSql,
  getTestOeeSqlExpressions,
} from "../../src/server/skills/test-oee-calculator/assets/test-oee-calculator.ts";
import { machinePeriodSql } from "../../src/server/skills/test-oee-calculator/assets/machine-metrics.ts";
import { readDailyMachines } from "../../src/server/dashboard/default/calculate/daily-machines.ts";

const day = "2026-01-01";

function fixture(t: TestContext) {
  const db = new DatabaseSync(":memory:");
  db.exec(readFileSync("scripts/database/schema.sql", "utf8"));
  t.after(() => db.close());
  const availability = db.prepare(`INSERT INTO oee_availability
    (tool_name,lot_id,final_state,step,date,time_span) VALUES(?,?,'Test(Normal)',?,?,100)`);
  const dut = db.prepare(`INSERT INTO oee_dut_utilization
    (machine_id,lot_id,step_id,date,in_qty,out_qty,dut_num,test_stage,touchdown_index,start_time,end_time)
    VALUES(?,?,?,?,?,?,'100',?,'1','2026-01-01T00:00:00Z','2026-01-01T00:00:10Z')`);
  return {
    db,
    a(machine: string, kind = "MT", date = day, lot = "P1") {
      availability.run(machine, lot, kind === "MT" ? "5000" : "7000", date);
    },
    d(lot: string, input: number | string, output: number | string,
      options: { machine?: string; kind?: string; step?: string; date?: string; stage?: string } = {}) {
      dut.run(options.machine ?? "MT", lot, options.step ?? (options.kind === "ST" ? "7000" : "5000"),
        options.date ?? day, String(input), String(output), options.stage ?? "1st");
    },
    daily(start = day, end = start) { return db.prepare(getDefaultTestOeeSql(start, end).sql).all(); },
    labels(start = day, end = start, alias?: string) {
      const e = getTestOeeSqlExpressions("dut", start, end, alias);
      return db.prepare(`SELECT lot_id, ${e.inputQuantityWithoutRetestExpression} AS initial_input,
        ${e.yieldCalculationLabelExpression} AS label FROM oee_dut_utilization ${alias ?? ""}
        WHERE ${e.dateRangePredicate} AND ${e.sourceLotPredicate} AND ${e.platformPredicate} ORDER BY id`).all();
    },
  };
}

test("Yield filters invalid LOTs without removing their Performance samples across all query views", (t) => {
  const f = fixture(t);
  for (const kind of ["MT", "ST"]) {
    const options = { machine: kind, kind };
    // T LOTs remain eligible in Availability while DUT excludes them before every aggregate.
    f.a(kind, kind, day, "T1");
    f.d("P-GOOD-" + kind, 100, 80, options);
    f.d("P-GOOD-" + kind, 20, 10, { ...options, stage: "Rescreen" });
    f.d("P-BAD-" + kind, 100, 90, options);
    f.d("P-BAD-" + kind, 20, 15, { ...options, stage: "Rescreen" });
    f.d("T1", 100_000, 100_000, options);
  }
  const daily = f.daily();
  for (const row of daily) {
    assert.equal(row["availability_rows"], 1);
    assert.equal(row["availability"], 1);
    assert.equal(row["dut_rows"], 4);
    assert.equal(row["yield_rows"], 2);
    assert.equal(row["yield_input_quantity"], 120);
    assert.equal(row["yield_output_quantity"], 90);
    assert.equal(row["input_quantity"], 240);
    assert.equal(row["output_quantity"], 195);
    assert.equal(row["socket_quantity"], 400);
    assert.equal(row["valid_duration_rows"], 4);
    assert.equal(row["touchdown_count"], 4);
    assert.equal(row["actual_test_seconds"], 40);
    assert.equal(row["dut_on"], .6);
    assert.equal(row["test_time_performance"], 1);
    assert.equal(row["final_yield"], .75);
    assert.ok(Math.abs(Number(row["daily_test_oee"]) - .45) < 1e-12);
  }
  for (const grain of ["day", "week", "month", "quarter"] as const) {
    const rows = f.db.prepare(getMachinePeriodTestOeeSql(day, day, grain).sql).all();
    assert.equal(rows.length, 2);
    for (const row of rows) {
      assert.equal(row["dut_rows"], 4);
      assert.equal(row["yield_rows"], 2);
      assert.equal(row["final_yield"], .75);
    }
  }
  for (const byKind of [true, false]) {
    const rows = f.db.prepare(machinePeriodSql({ start: day, end: day }, byKind)).all();
    assert.deepEqual(rows.map((row) => row["final_yield"]), [75, 75]);
  }
  assert.deepEqual(readDailyMachines(f.db, day).map((row) => row["final_yield"]), [75, 75]);
  for (const view of ["overview", "trends"] as const) {
    const row = f.db.prepare(getDefaultTestOeeDashboardSql(day, day, view).sql).get()!;
    assert.equal(row["mt_yield_percent"], 75);
    assert.equal(row["st_yield_percent"], 75);
  }
  assert.equal(f.db.prepare("SELECT COUNT(*) n FROM oee_dut_utilization WHERE lot_id='T1'").get()!["n"], 2);
});

test("LOT labels preserve equality, exact stage matching and SQL NULL semantics", (t) => {
  const f = fixture(t);
  const cases = [
    { lot: "P-EQUAL", input: " 100 ", output: "90", stage: "1st", initial: 100, result: 100 / 120 },
    { lot: "P-NO-FIRST", input: "20", output: "30", stage: "Rescreen", initial: null, result: 1.5 },
    { lot: "P-BLANK-INPUT", input: " ", output: "10", stage: "1st", initial: null, result: null },
    { lot: "P-BLANK-OUTPUT", input: "10", output: "", stage: "1st", initial: 10, result: null },
    { lot: "P-ZERO", input: "0", output: "0", stage: "1st", initial: 0, result: null },
    { lot: "P-STAGE-CASE", input: "5", output: "10", stage: "1ST", initial: null, result: 2 },
    { lot: "P-STAGE-SPACE", input: "5", output: "10", stage: " 1st ", initial: null, result: 2 },
    { lot: "None", input: "100", output: "80", stage: "1st", initial: 100, result: null },
  ];
  for (const row of cases) {
    f.a(row.lot);
    f.d(row.lot, row.input, row.output, { machine: row.lot, stage: row.stage });
  }
  f.d("P-EQUAL", 20, 10, { machine: "P-EQUAL", stage: "Rescreen" });
  for (const alias of [undefined, "d"]) {
    const labels = f.labels(day, day, alias);
    assert.deepEqual(labels.map((row) => [row["initial_input"], row["label"]]),
      [...cases.map((row) => [row.initial, "T"]), [null, "T"]]);
  }
  const rows = f.db.prepare(getMachinePeriodTestOeeSql(day, day, "day").sql).all();
  for (const expected of cases) {
    const row = rows.find((entry) => entry["machine"] === expected.lot)!;
    assert.equal(row["final_yield"], expected.result, expected.lot);
    assert.equal(row["yield_rows"], expected.lot === "None" ? 0 : expected.lot === "P-EQUAL" ? 2 : 1);
  }
  const noYield = rows.find((row) => row["machine"] === "None")!;
  assert.equal(noYield["yield_input_quantity"], null);
  assert.equal(noYield["yield_output_quantity"], null);
  assert.equal(noYield["dut_on"], 1);
});

test("LOT labels span dates, machines and MT/ST within the filtered query range", (t) => {
  const f = fixture(t), end = "2026-01-02";
  f.a("A"); f.a("B", "ST", end); f.a("C");
  f.d("P-SHARED", 100, 80, { machine: "A" });
  f.d("P-SHARED", 20, 30, { machine: "B", kind: "ST", date: end, stage: "Rescreen" });
  f.d("P-INDEPENDENT", 100, 90, { machine: "C" });
  // These initial inputs must not rescue the shared LOT inside the selected range.
  f.d("P-SHARED", 1_000, 0, { date: "2025-12-31" });
  f.d("P-SHARED", 1_000, 0, { date: "2026-01-03" });
  f.d("P-SHARED", 1_000, 0, { machine: "TSPH001" });
  assert.deepEqual(f.labels(day, end, "d").map((row) => row["label"]), ["F", "F", "T"]);
  assert.deepEqual(f.labels(day, day).map((row) => row["label"]), ["T", "T"]);
  assert.equal(f.labels(end, end)[0]!["label"], "T", "a retest-only range follows ELSE T");
  const daily = f.daily(day, end);
  assert.equal(daily[0]!["yield_rows"], 1);
  assert.equal(daily[0]!["final_yield"], .9);
  assert.equal(daily[3]!["yield_rows"], 0);
  assert.equal(daily[3]!["final_yield"], null);
  assert.equal(daily[3]!["dut_on"], .2);
  for (const grain of ["day", "week", "month", "quarter"] as const) {
    const rows = f.db.prepare(getMachinePeriodTestOeeSql(day, end, grain).sql).all();
    assert.equal(rows.length, 3);
    for (const machine of ["A", "B"]) {
      const row = rows.find((entry) => entry["machine"] === machine)!;
      assert.equal(row["yield_rows"], 0);
      assert.equal(row["yield_input_quantity"], null);
      assert.equal(row["final_yield"], null);
    }
    assert.equal(rows.find((row) => row["machine"] === "C")!["final_yield"], .9);
  }
});

test("LOT windows include unclassified DUT before the final MT/ST aggregation", (t) => {
  const f = fixture(t);
  f.a("MT");
  f.d("P1", 100, 90);
  f.d("P1", 20, 20, { machine: "DUT-ONLY", step: "x", stage: "Rescreen" });
  assert.deepEqual(f.labels().map((row) => row["label"]), ["F", "F"]);
  const mt = f.daily()[0]!;
  assert.equal(mt["dut_rows"], 1);
  assert.equal(mt["yield_rows"], 0);
  assert.equal(mt["final_yield"], null);
  assert.equal(mt["test_time_performance"], 1);
});
