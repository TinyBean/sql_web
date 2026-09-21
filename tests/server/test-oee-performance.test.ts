import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import test, { type TestContext } from "node:test";
import { getDefaultTestOeeDashboardSql, getDefaultTestOeeSql } from "../../src/server/skills/test-oee-calculator/assets/test-oee-calculator.ts";

function fixture(t: TestContext) {
  const db = new DatabaseSync(":memory:");
  db.exec(readFileSync("scripts/database/schema.sql", "utf8"));
  t.after(() => db.close());
  const availability = db.prepare("INSERT INTO oee_availability(tool_name,lot_id,final_state,step,date,time_span) VALUES(?,'P1','Test(Normal)',?,?,43200)");
  const dut = db.prepare(`INSERT INTO oee_dut_utilization
    (machine_id,lot_id,step_id,date,in_qty,out_qty,dut_num,test_stage,touchdown_index,start_time,end_time)
    VALUES(?,'P1',?,?,'10','8','20','1st',?,?,?)`);
  return {
    db,
    a(day: string, kind = "MT") { availability.run(kind, kind === "MT" ? "5000" : "7000", day); },
    d(day: string, seconds: number | null, td: string | null = "1", kind = "MT") {
      dut.run(kind, kind === "MT" ? "5000" : "7000", day, td, "2026-01-01T23:59:59.500Z",
        seconds === null ? "invalid" : new Date(Date.parse("2026-01-01T23:59:59.500Z") + seconds * 1000).toISOString());
    },
    rows(start: string, end = start) { return db.prepare(getDefaultTestOeeSql(start, end).sql).all(); },
  };
}

test("0.2 percent trimming handles 999/1000/2000 samples, boundary ties and separate dates/types", (t) => {
  const f = fixture(t);
  for (const [day, count, trimmed] of [["2026-01-01", 999, 0], ["2026-01-02", 1000, 1], ["2026-01-03", 2000, 2]] as const) {
    f.a(day); f.a(day, "ST");
    f.d(day, 1); f.d(day, 100);
    for (let i = 2; i < count; i++) f.d(day, 10);
    f.d(day, 30, "1", "ST");
    const [mt, st] = f.rows(day);
    assert.equal(mt!["valid_duration_rows"], count);
    assert.equal(mt!["trimmed_rows_each_tail"], trimmed);
    assert.equal(mt!["actual_test_seconds"], count * 10 + 81);
    assert.equal(mt!["touchdown_count"], count);
    const expected = trimmed === 0 ? 1 : count * 10 / (count * 10 + 81);
    assert.ok(Math.abs(Number(mt!["test_time_performance"]) - expected) < 1e-12);
    assert.ok(Math.abs(Number(mt!["daily_test_oee"]) - .2 * expected) < 1e-12);
    assert.equal(mt!["dut_on"], .5);
    assert.equal(mt!["performance"], mt!["dut_on"]);
    assert.equal(st!["trimmed_mean_test_seconds"], 30);
    assert.equal(st!["test_time_performance"], 1);
  }
  const overview = f.db.prepare(getDefaultTestOeeDashboardSql("2026-01-01", "2026-01-03", "overview").sql).get()!;
  const expectedTime = (1 + 10000 / 10081 + 20000 / 20081) / 3;
  assert.ok(Math.abs(Number(overview["mt_test_time_percent"]) - expectedTime * 100) < 1e-10);
  assert.ok(Math.abs(Number(overview["mt_oee_percent"]) - expectedTime * 20) < 1e-10);
  assert.equal(overview["st_test_time_percent"], 100);
  assert.equal(overview["mt_dut_on_percent"], overview["mt_performance_percent"]);
  const trends = f.db.prepare(getDefaultTestOeeDashboardSql("2026-01-01", "2026-01-03", "trends").sql).all();
  assert.equal(trends[1]!["mt_test_time_percent"], 10000 / 10081 * 100);
  assert.equal(trends[1]!["st_test_time_percent"], 100);
});

test("time differences keep fractional seconds across midnight and independent null populations", (t) => {
  const f = fixture(t); const day = "2026-01-01";
  f.a(day);
  f.d(day, 1.125, "  +2  ");
  f.d(day, 1.125, "-3");
  for (const label of ["0", null, "", "bad", "1x", "1.5", "--2"]) f.d(day, 1.125, label);
  f.d(day, null, "4");
  const mt = f.rows(day)[0]!;
  assert.equal(mt["valid_duration_rows"], 9);
  assert.equal(mt["trimmed_mean_test_seconds"], 1.125);
  assert.equal(mt["touchdown_count"], 3);
  assert.equal(mt["actual_test_seconds"], 10.125);
  assert.equal(mt["test_time_performance"], 1 / 3);
});

test("missing aggregates and zero totals are null, with no clamping or invented test efficiency", (t) => {
  const f = fixture(t);
  const cases: readonly [string, number | null, string | null][] = [
    ["2026-01-01", null, "1"], ["2026-01-02", 0, "1"], ["2026-01-03", 10, null],
  ];
  for (const [day, seconds, label] of cases) {
    f.a(day); f.d(day, seconds, label);
    assert.equal(f.rows(day)[0]!["test_time_performance"], null);
    assert.equal(f.rows(day)[0]!["daily_test_oee"], null);
  }
  const day = "2026-01-04";
  f.a(day); f.d(day, 10); f.d(day, null);
  assert.equal(f.rows(day)[0]!["test_time_performance"], 2);
  f.a("2026-01-05"); f.d("2026-01-05", -10);
  assert.equal(f.rows("2026-01-05")[0]!["actual_test_seconds"], -10);
  const overview = f.db.prepare(getDefaultTestOeeDashboardSql("2026-01-01", "2026-01-04", "overview").sql).get()!;
  assert.equal(overview["mt_calculable_day_count"], 1);
  assert.equal(overview["mt_test_time_percent"], 200);
  assert.equal(overview["mt_availability_percent"], 50);
});

test("LOT and PCIe exclusions and business-day labels apply before trimming", (t) => {
  const f = fixture(t); const day = "2026-01-01";
  f.a(day); f.d(day + "T00:00:00.000Z", 10);
  f.d(day, 10000); f.db.exec("UPDATE oee_dut_utilization SET machine_id='TSPH001' WHERE id=2");
  f.d(day, 20000); f.db.exec("UPDATE oee_dut_utilization SET lot_id='None' WHERE id=3");
  f.d(day, 30000); f.db.exec("UPDATE oee_dut_utilization SET step_id='x' WHERE id=4");
  const mt = f.rows(day)[0]!;
  assert.equal(mt["dut_rows"], 1);
  assert.equal(mt["trimmed_mean_test_seconds"], 10);
  assert.equal(mt["test_time_performance"], 1);
  // Actual timestamps belong to Jan 1/2, while the business label alone determines the group.
  assert.equal(f.rows("2026-01-02")[0]!["daily_test_oee"], null);
});
