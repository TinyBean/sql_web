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
      options: { machine?: string; kind?: string; step?: string; date?: string | null; stage?: string } = {}) {
      dut.run(options.machine ?? "MT", lot, options.step ?? (options.kind === "ST" ? "7000" : "5000"),
        options.date === undefined ? day : options.date, String(input), String(output), options.stage ?? "1st");
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
  for (const alias of [undefined, "d", "yield_history", "yield_history_source"]) {
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

test("LOT labels span all imported dates, machines and MT/ST regardless of the report range", (t) => {
  const f = fixture(t), end = "2026-01-02";
  f.a("A"); f.a("B", "ST", end); f.a("C");
  f.d("P-SHARED", 100, 80, { machine: "A" });
  f.d("P-SHARED", 20, 30, { machine: "B", kind: "ST", date: end, stage: "Rescreen" });
  f.d("P-INDEPENDENT", 100, 90, { machine: "C" });
  // Earlier/later matching input and output leave the negative LOT balance unchanged.
  f.d("P-SHARED", 1_000, 1_000, { date: "2025-12-31" });
  f.d("P-SHARED", 1_000, 1_000, { date: "2026-01-03" });
  // Excluded PCIe history must not rescue the LOT.
  f.d("P-SHARED", 1_000, 0, { machine: "TSPH001" });
  assert.deepEqual(f.labels(day, end, "d").map((row) => row["label"]), ["F", "F", "T"]);
  assert.deepEqual(f.labels(day, day).map((row) => row["label"]), ["F", "T"]);
  assert.equal(f.labels(end, end)[0]!["label"], "F", "a retest-only report still uses imported initial history");
  const daily = f.daily(day, end);
  assert.equal(daily[0]!["yield_rows"], 1);
  assert.equal(daily[0]!["final_yield"], .9);
  assert.equal(daily[3]!["yield_rows"], 0);
  assert.equal(daily[3]!["final_yield"], null);
  assert.equal(daily[3]!["dut_on"], .2);
  for (const [startDate, endDate] of [[day, day], [end, end], [day, end]]) {
    const rows = f.db.prepare(getMachinePeriodTestOeeSql(startDate!, endDate!, "day").sql).all();
    for (const row of rows.filter((entry) => entry["machine"] !== "C")) {
      assert.equal(row["yield_rows"], 0);
      assert.equal(row["final_yield"], null);
      assert.equal(row["dut_rows"], 1);
    }
  }
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

test("history affects the LOT label without leaking into report quantities, coverage or Performance", (t) => {
  const f = fixture(t);
  f.a("MT");
  f.d("P-HISTORY", 10, 5);
  f.d("P-HISTORY", 100, 60, { machine: "PAST", date: "2025-12-31" });
  f.d("P-HISTORY", 500, 20, { machine: "FUTURE", kind: "ST", date: "2026-01-02", stage: "Rescreen" });
  f.d("P-UNRELATED", 0, 100_000, { date: "2026-01-02" });
  for (const alias of [undefined, "d", "yield_history"]) {
    assert.deepEqual(f.labels(day, day, alias).map((row) => row["label"]), ["T"]);
  }
  const before = f.daily()[0]!;
  assert.equal(before["yield_input_quantity"], 10);
  assert.equal(before["yield_output_quantity"], 5);
  assert.equal(before["final_yield"], .5);
  for (const grain of ["day", "week", "month", "quarter"] as const) {
    const row = f.db.prepare(getMachinePeriodTestOeeSql(day, day, grain).sql).get()!;
    assert.equal(row["dut_days"], 1);
    assert.equal(row["dut_rows"], 1);
    assert.equal(row["final_yield"], .5);
  }
  f.db.exec("UPDATE oee_dut_utilization SET out_qty='100' WHERE machine_id='FUTURE'");
  for (const alias of [undefined, "d", "yield_history"]) {
    assert.deepEqual(f.labels(day, day, alias).map((row) => row["label"]), ["F"]);
  }
  const after = f.daily()[0]!;
  assert.equal(after["yield_rows"], 0);
  assert.equal(after["yield_input_quantity"], null);
  assert.equal(after["final_yield"], null);
  for (const key of ["dut_rows", "input_quantity", "output_quantity", "socket_quantity", "touchdown_count",
    "actual_test_seconds", "valid_duration_rows", "trimmed_mean_test_seconds", "dut_on", "test_time_performance"]) {
    assert.equal(after[key], before[key], key);
  }
  assert.equal(after["input_quantity"], 10);
  assert.equal(after["output_quantity"], 5);
  assert.equal(after["dut_rows"], 1);
});

test("imported records without a date and VALUES lookups use the same complete LOT label", (t) => {
  const f = fixture(t);
  f.a("MT");
  f.d("P1", 100, 90);
  f.d("P1", 20, 15, { date: null, stage: "Rescreen" });
  const e = getTestOeeSqlExpressions("dut", day, day, "sample");
  const sample = f.db.prepare(`WITH lots(lot_id) AS (VALUES ('P1'))
    SELECT ${e.yieldCalculationLabelExpression} AS label FROM lots sample`).get()!;
  assert.equal(sample["label"], "F");
  assert.equal(f.labels()[0]!["label"], "F");
  const mt = f.daily()[0]!;
  assert.equal(mt["yield_rows"], 0);
  assert.equal(mt["dut_rows"], 1);
  assert.equal(mt["input_quantity"], 100);
});

test("complete LOT labels include unclassified DUT before the final MT/ST aggregation", (t) => {
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
