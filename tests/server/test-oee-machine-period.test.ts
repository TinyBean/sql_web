import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import test, { type TestContext } from "node:test";
import {
  getMachineDailyTestOeeSql, getMachinePeriodTestOeeSql, type MachinePeriodGrain,
} from "../../src/server/skills/test-oee-calculator/assets/test-oee-calculator.ts";
import { machinePeriodSql } from "../../src/server/skills/test-oee-calculator/assets/machine-metrics.ts";

function fixture(t: TestContext) {
  const db = new DatabaseSync(":memory:");
  db.exec(readFileSync("scripts/database/schema.sql", "utf8"));
  t.after(() => db.close());
  const a = db.prepare(`INSERT INTO oee_availability
    (tool_name,lot_id,final_state,step,date,time_span) VALUES(?,?,'Test(Normal)',?,?,100)`);
  const d = db.prepare(`INSERT INTO oee_dut_utilization
    (machine_id,lot_id,step_id,date,in_qty,out_qty,dut_num,test_stage,touchdown_index,start_time,end_time)
    VALUES(?,?,?,?,'10','8','20','1st',?,?,?)`);
  return {
    db,
    a(machine: string, day: string, kind = "MT", lot = "P1") {
      a.run(machine, lot, kind === "MT" ? "5000" : "7000", day);
    },
    d(machine: string, day: string, seconds: number | null, td: string | null = "1", kind = "MT", lot = "P1") {
      const start = "2026-01-01T23:59:59.500Z";
      d.run(machine, lot, kind === "MT" ? "5000" : "7000", day, td, start,
        seconds === null ? null : new Date(Date.parse(start) + seconds * 1000).toISOString());
    },
    rows(start: string, end: string, grain: MachinePeriodGrain) {
      return db.prepare(getMachinePeriodTestOeeSql(start, end, grain).sql).all();
    },
  };
}

function closeTo(actual: unknown, expected: number) {
  assert.equal(typeof actual, "number");
  assert.ok(Math.abs(Number(actual) - expected) < 1e-12, `${actual} != ${expected}`);
}

test("each machine period trims 1% across days at 199/200/400 rows and isolates machines and types", (t) => {
  for (const grain of ["week", "month", "quarter"] as const) {
    for (const count of [199, 200, 400]) {
      const f = fixture(t);
      const start = "2026-01-04", end = "2026-01-05";
      for (const day of [start, end]) f.a("A", day);
      f.a("A", start, "ST"); f.a("B", start);
      f.d("A", start, 1); f.d("A", end, 100, "1", "MT", "None");
      for (let i = 2; i < count; i++) f.d("A", i % 2 ? start : end, 10);
      f.d("A", start, 30, "1", "ST"); f.d("B", start, 50);
      f.d("DUT-ONLY", start, 100_000);
      const rows = f.rows(start, end, grain);
      assert.equal(rows.length, 3);
      const mt = rows.find((r) => r["machine"] === "A" && r["kind"] === "MT")!;
      const trim = Math.floor(count / 200);
      const expected = trim ? count * 10 / (count * 10 + 81) : 1;
      assert.equal(mt["valid_duration_rows"], count);
      assert.equal(mt["trimmed_rows_each_tail"], trim);
      assert.equal(mt["touchdown_count"], count);
      assert.equal(mt["actual_test_seconds"], count * 10 + 81);
      assert.equal(mt["yield_rows"], count - 1);
      assert.equal(mt["availability_days"], 2);
      assert.equal(mt["dut_days"], 2);
      closeTo(mt["raw_test_time_performance"], expected);
      closeTo(mt["test_time_performance"], expected);
      closeTo(mt["test_oee"], .4 * expected);
      closeTo(mt["effective_oee"], .4 * expected);
      assert.equal(rows.find((r) => r["machine"] === "B")!["trimmed_mean_test_seconds"], 50);
      assert.equal(rows.find((r) => r["kind"] === "ST")!["trimmed_mean_test_seconds"], 30);
      const ranked = f.db.prepare(machinePeriodSql({ start, end }, true)).all()
        .find((r) => r["machine"] === "A" && r["kind"] === "MT")!;
      closeTo(ranked["test_time_performance"], expected * 100);
      closeTo(ranked["oee"], Number(mt["test_oee"]) * 100);
      for (const lot of ["Q1", "E1"]) {
        f.a("A", start, "ST", lot); f.d("A", start, 1_000_000, "1", "MT", lot);
      }
      f.a("TSPH001", start); f.d("TSPH001", start, 1_000_000);
      f.d("A", "2026-01-03", 1_000_000); f.d("A", "2026-01-06", 1_000_000);
      assert.deepEqual(f.rows(start, end, grain), rows);
    }
  }
});

test("day grain preserves the existing machine-day query and rejects invalid periods", (t) => {
  const f = fixture(t);
  f.a("A", "2026-01-04"); f.d("A", "2026-01-04", 10);
  assert.deepEqual(f.rows("2026-01-04", "2026-01-05", "day"),
    f.db.prepare(getMachineDailyTestOeeSql("2026-01-04", "2026-01-05").sql).all());
  assert.throws(() => getMachinePeriodTestOeeSql("2026-02-30", "2026-03-01", "month"));
  assert.throws(() => getMachinePeriodTestOeeSql("2026-02-01", "2026-01-01", "month"));
  assert.throws(() => getMachinePeriodTestOeeSql("2026-01-01", "2026-02-01", "report_period" as never));
});

test("weeks use Sunday %U labels, split years, and expose selected bounds with actual coverage", (t) => {
  const f = fixture(t);
  for (const day of ["2025-12-31", "2026-01-01", "2026-01-03", "2026-01-04"]) {
    f.a("A", day + "T00:00:00.000Z"); f.d("A", day + "T00:00:00.000Z", 10);
  }
  const rows = f.rows("2025-12-31", "2026-01-04", "week");
  assert.deepEqual(rows.map((r) => [r["period_label"], r["period_start"], r["period_end"],
    r["is_partial_period"], r["availability_days"], r["dut_days"]]), [
    ["2025-W52", "2025-12-31", "2025-12-31", 1, 1, 1],
    ["2026-W00", "2026-01-01", "2026-01-03", 1, 2, 2],
    ["2026-W01", "2026-01-04", "2026-01-04", 1, 1, 1],
  ]);
  const complete = f.rows("2026-01-04", "2026-01-10", "week")[0]!;
  assert.equal(complete["is_partial_period"], 0);
  assert.equal(complete["availability_days"], 1);
});

test("natural months and quarters clip query boundaries without filling missing periods", (t) => {
  const f = fixture(t);
  for (const day of ["2026-01-05", "2026-01-15", "2026-03-31", "2026-04-01"]) {
    f.a("A", day); f.d("A", day, 10);
  }
  const months = f.rows("2026-01-01", "2026-03-31", "month");
  assert.deepEqual(months.map((r) => [r["period_label"], r["period_start"], r["period_end"], r["is_partial_period"]]), [
    ["2026-01", "2026-01-01", "2026-01-31", 0], ["2026-03", "2026-03-01", "2026-03-31", 0],
  ]);
  assert.equal(months[0]!["availability_days"], 2);
  const clipped = f.rows("2026-01-05", "2026-01-20", "month")[0]!;
  assert.equal(clipped["period_start"], "2026-01-05");
  assert.equal(clipped["period_end"], "2026-01-20");
  assert.equal(clipped["is_partial_period"], 1);
  assert.deepEqual(f.rows("2026-01-01", "2026-04-01", "quarter")
    .map((r) => [r["period_label"], r["period_start"], r["period_end"], r["is_partial_period"]]), [
    ["2026-Q1", "2026-01-01", "2026-03-31", 0], ["2026-Q2", "2026-04-01", "2026-04-01", 1],
  ]);
});

test("period Test Time caps only its factor and keeps independent missing populations", (t) => {
  const f = fixture(t), day = "2026-01-04";
  for (const grain of ["week", "month", "quarter"] as const) {
    // Repeat queries over one shared fixture to verify every grain's NULL and cap behavior.
    if (grain === "week") {
      f.a("CAP", day); f.d("CAP", day, 1.125); f.d("CAP", day, null);
      f.db.exec("UPDATE oee_dut_utilization SET dut_num='5',out_qty='30' WHERE machine_id='CAP'");
      f.a("LOW", day); f.d("LOW", day, 10); f.d("LOW", day, 10, "bad");
      f.a("NO-TD", day); f.d("NO-TD", day, 10, "0");
      f.a("NO-TIME", day); f.d("NO-TIME", day, null);
      f.a("ZERO-TIME", day); f.d("ZERO-TIME", day, 0);
      f.a("NO-DUT", day);
      f.a("NO-YIELD", day); f.d("NO-YIELD", day, 10, "1", "MT", "None");
    }
    const rows = f.rows(day, "2026-01-05", grain);
    const cap = rows.find((r) => r["machine"] === "CAP")!;
    assert.equal(cap["raw_test_time_performance"], 2);
    assert.equal(cap["test_time_performance"], 1);
    assert.equal(cap["test_oee"], 6);
    assert.equal(cap["effective_oee"], 6);
    assert.equal(rows.find((r) => r["machine"] === "LOW")!["test_time_performance"], .5);
    for (const machine of ["NO-TD", "NO-TIME", "ZERO-TIME", "NO-DUT"]) {
      assert.equal(rows.find((r) => r["machine"] === machine)!["test_time_performance"], null);
    }
    const noYield = rows.find((r) => r["machine"] === "NO-YIELD")!;
    assert.equal(noYield["test_time_performance"], 1);
    assert.equal(noYield["test_oee"], null);
  }
});

test("merged TOP10 combines type standards before the cap and counts each covered day once", (t) => {
  const f = fixture(t), day = "2026-01-04";
  f.a("A", day); f.a("A", day, "ST");
  f.d("A", day, 1); f.d("A", day, null);
  f.d("A", day, 10, "1", "ST"); f.d("A", day, 10, "bad", "ST");
  const range = { start: day, end: "2026-01-05" };
  const row = f.db.prepare(machinePeriodSql(range)).all()[0]!;
  assert.equal(row["kind"], "MT");
  assert.equal(row["availability_days"], 1);
  assert.equal(row["dut_days"], 1);
  closeTo(row["raw_test_time_performance"], 12 / 21 * 100);
  closeTo(row["test_time_performance"], 12 / 21 * 100);
  f.db.exec("UPDATE oee_dut_utilization SET end_time=NULL WHERE step_id='7000'");
  assert.equal(f.db.prepare(machinePeriodSql(range)).all()[0]!["test_time_performance"], null);
});
