import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync, type SQLOutputValue } from "node:sqlite";
import test, { type TestContext } from "node:test";
import {
  getDefaultTestOeeDashboardSql,
  getDefaultTestOeeSql,
  getTestOeeSqlExpressions,
} from "../../src/server/skills/test-oee-calculator/assets/test-oee-calculator.ts";

type Row = Record<string, SQLOutputValue>;

function assertValues(row: Row, expected: Record<string, number | null>): void {
  for (const [column, value] of Object.entries(expected)) {
    if (value === null) {
      assert.equal(row[column], null, column);
    } else {
      assert.equal(typeof row[column], "number", column);
      assert.ok(Math.abs(Number(row[column]) - value) < 1e-10,
        `${column}: expected ${value}, got ${row[column]}`);
    }
  }
}

function fixture(t: TestContext) {
  const db = new DatabaseSync(":memory:");
  db.exec(readFileSync("scripts/database/schema.sql", "utf8"));
  t.after(() => db.close());
  const availability = db.prepare(`INSERT INTO oee_availability
    (tool_name,lot_id,final_state,step,date,time_span) VALUES(?,?,?,?,?,?)`);
  const dut = db.prepare(`INSERT INTO oee_dut_utilization
    (machine_id,lot_id,step_id,date,in_qty,out_qty,dut_num,test_stage,touchdown_index,start_time,end_time)
    VALUES(?,?,?,?,?,?,?,'1st',?,?,?)`);
  return {
    db,
    a(day: string, state: string, seconds: number,
      options: { machine?: string; lot?: string; step?: string } = {}) {
      availability.run(options.machine ?? "MT", options.lot ?? "P1", state,
        options.step ?? "5000", day, seconds);
    },
    d(day: string, options: {
      kind?: "MT" | "ST"; input?: number; output?: number; sockets?: number;
      td?: string | null; seconds?: number | null; lot?: string;
    } = {}) {
      const kind = options.kind ?? "MT";
      const seconds = options.seconds === undefined ? 10 : options.seconds;
      dut.run(kind, options.lot ?? "P1", kind === "MT" ? "5000" : "7000", day,
        String(options.input ?? 10), String(options.output ?? 8), String(options.sockets ?? 20),
        options.td === undefined ? "1" : options.td, "2026-01-01T00:00:00.000Z",
        seconds === null ? null : new Date(Date.parse("2026-01-01T00:00:00.000Z") + seconds * 1000).toISOString());
    },
    rows(start: string, end = start) {
      return db.prepare(getDefaultTestOeeSql(start, end).sql).all();
    },
    overview(start: string, end = start) {
      return db.prepare(getDefaultTestOeeDashboardSql(start, end, "overview").sql).get()!;
    },
    trends(start: string, end = start) {
      return db.prepare(getDefaultTestOeeDashboardSql(start, end, "trends").sql).all();
    },
  };
}

test("partial-day state totals produce the expected Availability, Idle and both OEE metrics", (t) => {
  const f = fixture(t);
  const day = "2026-01-01";
  f.a(day, "Test(Normal)", 21_600);
  f.a(day, "IDLE", 10_800);
  f.a(day, "PM", 10_800);
  // Ten equal durations, nine valid TD labels: Test Time is 90%.
  for (let i = 0; i < 10; i++) {
    f.d(day, { input: 80, output: 76, sockets: 100, td: i === 9 ? "0" : "1" });
  }
  assertValues(f.rows(day)[0]!, {
    idle_seconds: 10_800, available_seconds: 43_200, idle: .25, availability: .5,
    effective_availability: .7, dut_on: .8, performance: .8, test_time_performance: .9,
    final_yield: .95, daily_test_oee: .342, daily_effective_oee: .4788,
    period_test_oee: .342, period_effective_oee: .4788,
    calculable_day_count: 1, effective_calculable_day_count: 1,
  });
  assertValues(f.overview(day), {
    mt_oee_percent: 34.2, mt_effective_oee_percent: 47.88, overall_effective_oee_percent: 47.88,
    mt_idle_percent: 25, mt_effective_availability_percent: 70,
    mt_effective_dut_on_percent: 80, mt_effective_test_time_percent: 90, mt_effective_yield_percent: 95,
  });
  assertValues(f.trends(day)[0]!, {
    mt_oee_percent: 34.2, mt_idle_percent: 25, mt_effective_availability_percent: 70,
    mt_effective_oee_percent: 47.88, st_idle_percent: null, st_effective_oee_percent: null,
  });
});

test("Idle predicates match IDLE anywhere in the raw state with and without table aliases", (t) => {
  const f = fixture(t);
  const day = "2026-01-01";
  const idleStates = ["IDLE", "IDLE_NoWIP", "IDLE_WaitARV", "IDLE_NoTask(xAny)", "IDLE ", "PRE_IDLE", "PRE_IDLE_POST"];
  for (const state of [...idleStates, "idle", "Assistance", "HangUp", "PM"]) {
    f.a(day, state, 100, { lot: "None" });
  }
  for (const alias of [undefined, "a"]) {
    const expressions = getTestOeeSqlExpressions("availability", day, day, alias);
    assert.ok(expressions.idlePredicate);
    const matches = f.db.prepare(`SELECT final_state FROM oee_availability ${alias ?? ""}
      WHERE ${expressions.idlePredicate} ORDER BY id`).all();
    assert.deepEqual(matches.map((row) => row["final_state"]), idleStates);
  }
  assert.equal(getTestOeeSqlExpressions("dut", day, day).idlePredicate, undefined);
});

test("only Yield filters LOT prefixes; Performance and state totals include None, X, Q and E", (t) => {
  const f = fixture(t);
  for (const [kind, step] of [["MT", "5000"], ["ST", "7000"]] as const) {
    const day = "2026-01-01";
    f.a(day, "Test(Normal)", 18_000, { machine: kind, step, lot: "None" });
    f.a(day, "IDLE", 9_000, { machine: kind, step, lot: "X1" });
    f.a(day, "PM", 9_000, { machine: kind, step, lot: "Q1" });
    f.d(day, { kind, lot: "P1", input: 80, output: 60, sockets: 100 });
    f.d(day, { kind, lot: "M1", input: 20, output: 20, sockets: 100 });
    for (const lot of ["None", "X1", "Q1", "E1"]) {
      f.d(day, { kind, lot, input: 25, output: 0, sockets: 100, td: "0", seconds: 20 });
    }
    const row = f.rows(day).find((row) => row["kind"] === kind)!;
    assertValues(row, {
      available_seconds: 36_000, availability: .5, idle: .25, effective_availability: .7,
      dut_rows: 6, input_quantity: 200, output_quantity: 80, socket_quantity: 600,
      yield_rows: 2, yield_input_quantity: 100, yield_output_quantity: 80,
      valid_duration_rows: 6, actual_test_seconds: 100, touchdown_count: 2,
      trimmed_mean_test_seconds: 100 / 6, dut_on: 1 / 3, test_time_performance: 1 / 3,
      final_yield: .8, daily_test_oee: 2 / 45, daily_effective_oee: 14 / 225,
    });
  }
});

test("missing or zero Yield input keeps other components visible without inventing OEE", (t) => {
  const f = fixture(t);
  for (const day of ["2026-01-01", "2026-01-02"]) {
    f.a(day, "Test(Normal)", 1_000, { lot: "None" });
    f.d(day, { lot: "None" });
  }
  f.d("2026-01-02", { input: 0, output: 0 });
  assertValues(f.rows("2026-01-01")[0]!, {
    dut_rows: 1, yield_rows: 0, yield_input_quantity: null, yield_output_quantity: null,
    availability: 1, dut_on: .5, test_time_performance: 1, final_yield: null,
    daily_test_oee: null, daily_effective_oee: null, calculable_day_count: 0,
  });
  assertValues(f.rows("2026-01-02")[0]!, {
    dut_rows: 2, yield_rows: 1, yield_input_quantity: 0, yield_output_quantity: 0,
    availability: 1, dut_on: .25, test_time_performance: 1, final_yield: null,
    daily_test_oee: null, daily_effective_oee: null,
  });
  assertValues(f.trends("2026-01-01")[0]!, {
    mt_availability_percent: 100, mt_dut_on_percent: 50, mt_test_time_percent: 100,
    mt_yield_percent: null, mt_oee_percent: null, mt_effective_oee_percent: null,
  });
  assertValues(f.overview("2026-01-01", "2026-01-02"), {
    mt_availability_day_count: 2, mt_dut_day_count: 2, mt_calculable_day_count: 0,
    mt_effective_calculable_day_count: 0, mt_oee_percent: null, mt_effective_oee_percent: null,
  });
});

test("zero state totals are undefined and negative totals are not clamped", (t) => {
  const f = fixture(t);
  for (const [day, running, loss] of [
    ["2026-01-01", 0, 0], ["2026-01-02", 100, -100], ["2026-01-03", 100, -200],
  ] as const) {
    f.a(day, "Test(Normal)", running); f.a(day, "PM", loss); f.d(day);
    const defined = day === "2026-01-03";
    assertValues(f.rows(day)[0]!, {
      availability_rows: 2, machine_count: 1, available_seconds: defined ? -100 : 0,
      availability: defined ? -1 : null, idle: defined ? 0 : null,
      effective_availability: defined ? -1 : null, daily_test_oee: defined ? -.4 : null,
      daily_effective_oee: defined ? -.4 : null,
    });
  }
});

test("Idle includes every LOT and loss-only machine while preserving PCIe, date and classification rules", (t) => {
  const f = fixture(t);
  const day = "2026-01-01";
  f.a(day, "Test(Normal)", 43_200);
  f.a(day, "IDLE", 21_600);
  f.a(day, "IDLE", 86_400, { machine: "LOSS_ONLY" });
  for (const state of ["IDLE_NoWIP", "IDLE_WaitARV", "IDLE_NoTask(xAny)"]) f.a(day, state, 1_800);
  f.a(day, "IDLE", 86_400, { machine: "INVALID_LOT", lot: "None" });
  f.a(day, "IDLE", 86_400, { lot: "X1" });
  f.a(day, "IDLE", 86_400, { machine: "TSPH001" });
  f.a(day, "IDLE", 86_400, { machine: "UNKNOWN", step: "0000" });
  f.a(day, "IDLE", 43_200, { machine: "ADH092", step: "0000" }); // ST platform fallback
  f.a(day, "Test(Normal)", 43_200, { machine: "ADH092", step: "0000" });
  f.a("2026-01-02T23:59:59.000Z", "IDLE", 43_200);
  f.a("2026-01-02T23:59:59.000Z", "Test(Normal)", 21_600);
  f.a("2025-12-31T23:59:59.000Z", "IDLE", 86_400);
  f.a("2026-01-03T00:00:00.000Z", "IDLE", 86_400);
  f.d(day); f.d(day, { kind: "ST" }); f.d("2026-01-02");
  const rows = f.rows(day, "2026-01-02");
  assert.equal(rows.length, 4);
  assertValues(rows[0]!, {
    availability_rows: 8, machine_count: 3, available_seconds: 329_400,
    idle_seconds: 286_200, idle: 53 / 61, availability: 8 / 61, effective_availability: 1,
    daily_test_oee: .4 * 8 / 61, daily_effective_oee: .4,
  });
  assertValues(rows[1]!, { machine_count: 1, idle: .5, availability: .5, effective_availability: 1 });
  assertValues(rows[2]!, { machine_count: 1, idle: 2 / 3, availability: 1 / 3, effective_availability: 1 });
  assertValues(rows[3]!, { idle: null, effective_availability: null, daily_effective_oee: null });
});

test("no IDLE, all IDLE and missing DUT preserve zero and null semantics", (t) => {
  const f = fixture(t);
  f.a("2026-01-01", "Test(Normal)", 43_200); f.d("2026-01-01");
  f.a("2026-01-02", "IDLE", 86_400); f.d("2026-01-02");
  f.a("2026-01-03", "PM", 86_400); f.d("2026-01-03");
  f.a("2026-01-04", "IDLE", 86_400); // Availability without DUT
  f.d("2026-01-05"); // DUT without Availability
  const mt = f.rows("2026-01-01", "2026-01-06").filter((row) => row["kind"] === "MT");
  assertValues(mt[0]!, { idle_seconds: 0, idle: 0, effective_availability: 1, daily_effective_oee: .4 });
  assertValues(mt[1]!, { idle: 1, availability: 0, effective_availability: 1, daily_test_oee: 0, daily_effective_oee: .4 });
  assertValues(mt[2]!, { idle: 0, effective_availability: 0, daily_effective_oee: 0 });
  assertValues(mt[3]!, { idle: 1, effective_availability: 1, daily_effective_oee: null });
  for (const row of mt.slice(4)) {
    assertValues(row, { idle_seconds: null, idle: null, effective_availability: null, daily_effective_oee: null });
  }
  for (const row of mt) {
    assertValues(row, { effective_calculable_day_count: 3, selected_day_count: 6, period_effective_oee: .8 / 3 });
  }
  assertValues(f.overview("2026-01-01", "2026-01-06"), {
    mt_effective_oee_percent: 80 / 3, mt_effective_calculable_day_count: 3, mt_selected_day_count: 6,
    mt_availability_day_count: 4, mt_dut_day_count: 3, st_effective_calculable_day_count: 0,
    st_effective_oee_percent: null, st_idle_percent: null, st_effective_availability_percent: null,
  });
  assertValues(f.trends("2026-01-04", "2026-01-05")[0]!, {
    mt_idle_percent: 100, mt_effective_availability_percent: 100, mt_effective_oee_percent: null,
  });
  const empty = f.overview("2026-02-01", "2026-02-02");
  for (const prefix of ["avg", "mt", "st"]) {
    for (const suffix of ["idle", "effective_availability", "effective_dut_on", "effective_test_time", "effective_yield"]) {
      assert.equal(empty[`${prefix}_${suffix}_percent`], null);
    }
  }
  assertValues(empty, {
    overall_effective_oee_percent: null, mt_effective_oee_percent: null, st_effective_oee_percent: null,
    effective_calculable_day_type_count: 0, mt_effective_calculable_day_count: 0,
    st_effective_calculable_day_count: 0, selected_day_type_count: 4,
  });
});

test("Effective OEE remains null when any DUT factor is not calculable", (t) => {
  const f = fixture(t);
  const cases = [{ sockets: 0 }, { input: 0 }, { seconds: null }, { seconds: 0 }, { td: null }];
  cases.forEach((options, index) => {
    const day = `2026-01-0${index + 1}`;
    f.a(day, "IDLE", 86_400); f.d(day, options);
    assertValues(f.rows(day)[0]!, {
      effective_availability: 1, daily_test_oee: null, daily_effective_oee: null,
      effective_calculable_day_count: 0, period_effective_oee: null,
    });
  });
});

test("zero effective denominator only excludes Effective OEE, while negative and above-one results remain unchanged", (t) => {
  const f = fixture(t);
  const cases = [
    { day: "2026-01-01", running: 86_400, idle: 86_400, availability: 1, effective: null },
    { day: "2026-01-02", running: 43_200, idle: 172_800, availability: .5, effective: -3.5 },
    { day: "2026-01-03", running: 129_600, idle: 0, availability: 1.5, effective: 1.5 },
    { day: "2026-01-04", running: 43_200, idle: -21_600, availability: .5, effective: 5 / 14 },
  ];
  for (const entry of cases) {
    f.a(entry.day, "Test(Normal)", entry.running); f.a(entry.day, "IDLE", entry.idle);
    // Negative source loss time exercises anomalous ratios with the actual total denominator.
    f.a(entry.day, "PM", 86_400 - entry.running - entry.idle); f.d(entry.day);
    assertValues(f.rows(entry.day)[0]!, {
      idle_seconds: entry.idle, availability: entry.availability, effective_availability: entry.effective,
      daily_test_oee: entry.availability * .4,
      daily_effective_oee: entry.effective === null ? null : entry.effective * .4,
      calculable_day_count: 1, effective_calculable_day_count: entry.effective === null ? 0 : 1,
    });
  }
});

test("periods and overview components use separate Effective OEE samples and equal daily weights", (t) => {
  const f = fixture(t);
  const start = "2026-01-01";
  const end = "2026-01-04";
  // Two machines on the first day, one on the second: the two days still have equal weight.
  for (const machine of ["M1", "M2"]) {
    f.a(start, "Test(Normal)", 43_200, { machine }); f.a(start, "IDLE", 21_600, { machine });
    f.a(start, "PM", 21_600, { machine });
  }
  f.d(start, { input: 80, output: 76, sockets: 100 }); // Effective OEE 53.2%, original 38%
  f.a("2026-01-02", "Test(Normal)", 21_600); f.a("2026-01-02", "IDLE", 21_600);
  f.a("2026-01-02", "PM", 43_200);
  f.d("2026-01-02"); // Effective OEE 1/6, original 10%
  f.a("2026-01-03", "Test(Normal)", 86_400); f.a("2026-01-03", "IDLE", 86_400);
  f.a("2026-01-03", "PM", -86_400); // Actual total 86400, effective denominator zero.
  f.d("2026-01-03", { input: 20, output: 2, sockets: 100 });
  f.d("2026-01-03", { input: 20, output: 2, sockets: 100, td: "0" }); // Original 1%, effective undefined
  f.a(start, "IDLE", 86_400, { machine: "ST", step: "7000" });
  f.d(start, { kind: "ST" }); // ST Effective OEE 40%
  const expectedMt = (.532 + 1 / 6) / 2;
  const overview = f.overview(start, end);
  assertValues(overview, {
    mt_oee_percent: (.38 + .1 + .01) / 3 * 100,
    mt_dut_on_percent: 50, mt_test_time_percent: 250 / 3, mt_yield_percent: 185 / 3,
    mt_effective_oee_percent: expectedMt * 100,
    mt_idle_percent: 25, mt_effective_availability_percent: (.7 + 5 / 12) / 2 * 100,
    mt_effective_dut_on_percent: 65, mt_effective_test_time_percent: 100, mt_effective_yield_percent: 87.5,
    mt_calculable_day_count: 3, mt_effective_calculable_day_count: 2, mt_selected_day_count: 4,
    st_effective_oee_percent: 40, st_idle_percent: 100, st_effective_availability_percent: 100,
    st_effective_dut_on_percent: 50, st_effective_test_time_percent: 100, st_effective_yield_percent: 80,
    st_effective_calculable_day_count: 1, st_selected_day_count: 4,
    overall_effective_oee_percent: (.532 + 1 / 6 + .4) / 3 * 100,
    avg_idle_percent: 50, avg_effective_availability_percent: (.7 + 5 / 12 + 1) / 3 * 100,
    avg_effective_dut_on_percent: 60, avg_effective_test_time_percent: 100, avg_effective_yield_percent: 85,
    calculable_day_type_count: 4, effective_calculable_day_type_count: 3, selected_day_type_count: 8,
  });
  for (const row of f.rows(start, end).filter((row) => row["kind"] === "MT")) {
    assertValues(row, { period_effective_oee: expectedMt, effective_calculable_day_count: 2, selected_day_count: 4 });
  }
  const trends = f.trends(start, end);
  assertValues(trends[2]!, { mt_oee_percent: 1, mt_idle_percent: 100, mt_effective_availability_percent: null, mt_effective_oee_percent: null });
  assertValues(trends[3]!, { mt_idle_percent: null, mt_effective_availability_percent: null, mt_effective_oee_percent: null });
});
