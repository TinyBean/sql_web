import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import test, { type TestContext } from "node:test";
import { getDefaultTestOeeSql, getMachineDailyTestOeeSql } from "../../src/server/skills/test-oee-calculator/assets/test-oee-calculator.ts";

function fixture(t: TestContext) {
  const db = new DatabaseSync(":memory:");
  db.exec(readFileSync("scripts/database/schema.sql", "utf8"));
  t.after(() => db.close());
  const availability = db.prepare(`INSERT INTO oee_availability
    (tool_name,lot_id,final_state,step,date,time_span) VALUES(?,?,?,?,?,?)`);
  const dut = db.prepare(`INSERT INTO oee_dut_utilization
    (machine_id,lot_id,step_id,date,in_qty,out_qty,dut_num,test_stage,touchdown_index,start_time,end_time)
    VALUES(?,?,?,?,'10','8','20','1st',?,?,?)`);
  return {
    db,
    a(machine: string, day: string, kind = "MT", seconds = 100, state = "Test(Normal)", lot = "P1") {
      availability.run(machine, lot, state, kind === "MT" ? "5000" : "7000", day, seconds);
    },
    d(machine: string, day: string, seconds: number | null, td: string | null = "1", kind = "MT", lot = "P1") {
      const start = "2026-01-01T23:59:59.500Z";
      dut.run(machine, lot, kind === "MT" ? "5000" : "7000", day, td, start,
        seconds === null ? null : new Date(Date.parse(start) + seconds * 1000).toISOString());
    },
    rows(start: string, end = start) { return db.prepare(getMachineDailyTestOeeSql(start, end).sql).all(); },
  };
}

function closeTo(actual: unknown, expected: number) {
  assert.equal(typeof actual, "number");
  assert.ok(Math.abs(Number(actual) - expected) < 1e-12, `${actual} != ${expected}`);
}

test("machine-day 1% trimming uses 199/200/400 samples and isolates machines, dates and types", (t) => {
  const f = fixture(t);
  for (const [day, count, trimmed] of [["2026-01-01", 199, 0], ["2026-01-02", 200, 1], ["2026-01-03", 400, 2]] as const) {
    f.a("A", day); f.a("A", day, "ST"); f.a("B", day);
    f.d("A", day, 1); f.d("A", day, 100, "1", "MT", "None");
    for (let i = 2; i < count; i++) f.d("A", day, 10);
    f.d("A", day, 30, "1", "ST");
    f.d("B", day, 50);
    f.d("DUT-ONLY", day, 100_000);
    const rows = f.rows(day);
    assert.equal(rows.length, 3);
    const mt = rows.find((row) => row["machine"] === "A" && row["kind"] === "MT")!;
    assert.equal(mt["valid_duration_rows"], count);
    assert.equal(mt["trimmed_rows_each_tail"], trimmed);
    assert.equal(mt["touchdown_count"], count);
    assert.equal(mt["actual_test_seconds"], count * 10 + 81);
    assert.equal(mt["yield_rows"], count - 1);
    const expected = trimmed ? count * 10 / (count * 10 + 81) : 1;
    closeTo(mt["raw_test_time_performance"], expected);
    closeTo(mt["test_time_performance"], expected);
    closeTo(mt["daily_test_oee"], .4 * expected);
    closeTo(mt["daily_effective_oee"], .4 * expected);
    assert.equal(rows[1]!["trimmed_mean_test_seconds"], 30);
    assert.equal(rows[2]!["trimmed_mean_test_seconds"], 50);
    assert.equal(rows[1]!["test_time_performance"], 1);
    assert.equal(rows[2]!["test_time_performance"], 1);
  }
});

test("machine-day Test Time caps only that factor and preserves independent null populations", (t) => {
  const f = fixture(t); const day = "2026-01-01";
  f.a("CAP", day); f.d("CAP", day, 1.125, " +2 "); f.d("CAP", day, null, "-3");
  const typeDay = f.db.prepare(getDefaultTestOeeSql(day, day).sql).all()[0]!;
  assert.equal(typeDay["test_time_performance"], 2);
  f.a("LOW", day); f.d("LOW", day, 1.125); f.d("LOW", day, 1.125, "bad");
  f.db.exec("UPDATE oee_dut_utilization SET out_qty='30', dut_num='5' WHERE machine_id='CAP'");
  const rows = f.rows(day);
  const cap = rows.find((row) => row["machine"] === "CAP")!;
  assert.equal(cap["valid_duration_rows"], 1);
  assert.equal(cap["touchdown_count"], 2);
  assert.equal(cap["actual_test_seconds"], 1.125);
  assert.equal(cap["raw_test_time_performance"], 2);
  assert.equal(cap["test_time_performance"], 1);
  assert.equal(cap["dut_on"], 2);
  assert.equal(cap["final_yield"], 3);
  assert.equal(cap["daily_test_oee"], 6);
  assert.equal(cap["daily_effective_oee"], 6);
  assert.equal(rows.find((row) => row["machine"] === "LOW")!["test_time_performance"], .5);
});

test("machine-day Test Time preserves negative values instead of imposing a lower cap", (t) => {
  const f = fixture(t); const day = "2026-01-01";
  f.a("A", day); f.d("A", day, 1000);
  for (let i = 1; i < 200; i++) f.d("A", day, -1);
  const row = f.rows(day)[0]!;
  assert.equal(row["trimmed_mean_test_seconds"], -1);
  closeTo(row["raw_test_time_performance"], -200 / 801);
  closeTo(row["test_time_performance"], -200 / 801);
});

test("missing machine-day inputs and zero denominators remain null", (t) => {
  const f = fixture(t); const day = "2026-01-01";
  for (const [machine, seconds, td] of [["NO-TIME", null, "1"], ["ZERO-TIME", 0, "1"], ["NO-TD", 10, "0"]] as const) {
    f.a(machine, day); f.d(machine, day, seconds, td);
  }
  f.a("NO-DUT", day);
  f.a("NO-YIELD", day); f.d("NO-YIELD", day, 10, "1", "MT", "None");
  f.a("ZERO-AVAILABILITY", day, "MT", 0); f.d("ZERO-AVAILABILITY", day, 10);
  f.a("ZERO-SOCKETS", day); f.d("ZERO-SOCKETS", day, 10);
  f.db.exec("UPDATE oee_dut_utilization SET dut_num='0' WHERE machine_id='ZERO-SOCKETS'");
  for (const row of f.rows(day)) {
    assert.equal(row["daily_test_oee"], null);
    assert.equal(row["daily_effective_oee"], null);
    if (["NO-TIME", "ZERO-TIME", "NO-TD", "NO-DUT"].includes(String(row["machine"]))) {
      assert.equal(row["raw_test_time_performance"], null);
      assert.equal(row["test_time_performance"], null);
    }
  }
  assert.deepEqual(f.rows("2026-01-02"), []);
});

test("machine-day source filters precede trimming and preserve the 199-sample boundary", (t) => {
  const f = fixture(t); const day = "2026-01-01";
  f.a("A", day); f.d("A", day, 1); f.d("A", day, 100);
  for (let i = 2; i < 199; i++) f.d("A", day, 10);
  const baseline = f.rows(day);
  assert.equal(baseline[0]!["trimmed_rows_each_tail"], 0);
  for (const lot of ["Q1", "E1"]) {
    f.a("A", day, "ST", 1_000_000, "PM", lot);
    f.d("A", day, 1_000_000, "1", "MT", lot);
    f.a(lot + "-ONLY", day, "MT", 100, "Test(Normal)", lot);
    f.d(lot + "-ONLY", day, 1, "1", "MT", lot);
  }
  f.a("TSPH001", day); f.d("TSPH001", day, 1_000_000);
  f.a("UNCLASSIFIED", day); f.d("UNCLASSIFIED", day, 1_000_000);
  f.db.exec("UPDATE oee_availability SET step='x' WHERE tool_name='UNCLASSIFIED'");
  f.db.exec("UPDATE oee_dut_utilization SET step_id='x' WHERE machine_id='UNCLASSIFIED'");
  f.d("A", "2025-12-31", 1_000_000); f.d("A", "2026-01-02", 1_000_000);
  assert.deepEqual(f.rows(day), baseline);
});

test("machine-day joins require day, machine and type and preserve whole end-day labels", (t) => {
  const f = fixture(t); const start = "2026-01-01"; const end = "2026-01-02";
  f.a("A", start, "MT", 40); f.a("A", start, "MT", 20, "IDLE_NoWIP", "None");
  f.a("A", start, "MT", 40, "PM", "None"); f.a("A", start, "ST");
  f.a("B", start); f.a("A", end + "T00:00:00.000Z");
  f.d("A", start, 10); f.d("A", start, 30, "1", "ST");
  f.d("DUT-ONLY", start, 50); f.d("A", end + "T00:00:00.000Z", 20);
  f.a("A", "2026-01-03"); f.d("A", "2026-01-03", 1000);
  const rows = f.rows(start, end);
  assert.equal(rows.length, 4);
  const mt = rows[0]!;
  assert.equal(mt["available_seconds"], 100);
  assert.equal(mt["availability"], .4);
  assert.equal(mt["idle"], .2);
  closeTo(mt["effective_availability"], .4 + .2 / 1.4);
  closeTo(mt["daily_test_oee"], .16);
  closeTo(mt["daily_effective_oee"], (.4 + .2 / 1.4) * .4);
  assert.equal(rows[1]!["trimmed_mean_test_seconds"], 30);
  assert.equal(rows[2]!["machine"], "B");
  assert.equal(rows[2]!["dut_rows"], null);
  assert.equal(rows[3]!["day"], end);
  assert.equal(rows[3]!["trimmed_mean_test_seconds"], 20);
});
