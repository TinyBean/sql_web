import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test, { type TestContext } from "node:test";
import { getDefaultTestOeeSql, getDefaultTestOeeDashboardSql, getPeriodTestOeeSql,
  getMachinePeriodTestOeeSql, type MachinePeriodGrain } from "../../src/server/skills/test-oee-calculator/assets/test-oee-calculator.ts";
import { machinePeriodSql } from "../../src/server/skills/test-oee-calculator/assets/machine-metrics.ts";
import { createTools } from "../../src/server/skills/test-oee-calculator/assets/tools.ts";
import { calculateDefaultDashboard, buildTypeOverviews, minimumComparisonPeriod,
  summarizePeriodOee } from "../../src/server/dashboard/default/calculate/index.ts";
import { assertReadOnlyQuery } from "../../src/server/database/database.ts";
import type { DashboardRow } from "../../src/shared/dashboard.ts";

function fixture(t: TestContext) {
  const db = new DatabaseSync(":memory:");
  t.after(() => db.close());
  db.exec(`CREATE TABLE oee_availability (
    id INTEGER PRIMARY KEY, tool_name TEXT, lot_id TEXT, final_state TEXT, step TEXT, date TEXT, time_span REAL
  ); CREATE TABLE oee_dut_utilization (
    id INTEGER PRIMARY KEY, machine_id TEXT, lot_id TEXT, in_qty TEXT, out_qty TEXT, dut_num TEXT,
    step_id TEXT, date TEXT, test_stage TEXT DEFAULT '1st', touchdown_index TEXT,
    start_time TEXT, end_time TEXT
  );`);
  const a = (day: string, running: number, total: number, kind = "MT", machine = kind) => {
    const insert = db.prepare("INSERT INTO oee_availability(tool_name,lot_id,final_state,step,date,time_span) VALUES(?, 'P1', ?, ?, ?, ?)");
    insert.run(machine, "Test(Normal)", kind === "MT" ? "5000" : "7000", day, running);
    insert.run(machine, "PM", kind === "MT" ? "5000" : "7000", day, total-running);
  };
  const d = (day: string, input: number, output: number, sockets: number, kind = "MT",
    seconds: number | null = 10, td: string | null = "1", machine = kind) => {
    const start = day+"T00:00:00.000Z";
    db.prepare(`INSERT INTO oee_dut_utilization(machine_id,lot_id,in_qty,out_qty,dut_num,step_id,date,
      touchdown_index,start_time,end_time) VALUES(?, 'P1', ?, ?, ?, ?, ?, ?, ?, ?)`).run(machine,
      String(input), String(output), String(sockets), kind === "MT" ? "5000" : "7000", day, td, start,
      seconds === null ? null : new Date(Date.parse(start)+seconds*1000).toISOString());
  };
  const rows = (start: string, end = start, grain: MachinePeriodGrain | "report_period" = "report_period") =>
    db.prepare(getPeriodTestOeeSql(start,end,grain).sql).all() as DashboardRow[];
  return { db, a, d, rows };
}
function close(actual: unknown, expected: number): void {
  assert.equal(typeof actual, "number");
  assert.ok(Math.abs(Number(actual)-expected)<1e-10, `expected ${expected}, got ${String(actual)}`);
}

test("pooled components and combined OEE agree across Skill, daily cards, trends and extrema", (t) => {
  const f = fixture(t), start = "2026-01-04", end = "2026-01-05";
  f.a(start,100,1000); f.d(start,80,40,100);
  f.a(end,1,1); f.d(end,20,20,1000);
  f.a(start,50,100,"ST"); f.d(start,500,450,1000,"ST");
  const rows=f.rows(start,end), mt=rows.find((r)=>r["kind"]==="MT")!, all=rows.find((r)=>r["kind"]==="ALL")!;
  const expectedMt=101/1001*(100/1100)*.6, expectedAll=151/1101*(600/2100)*.85;
  close(mt["availability"],101/1001); close(mt["dut_on"],100/1100); close(mt["final_yield"],.6);
  close(mt["test_oee"],expectedMt); close(all["test_oee"],expectedAll);
  const overview=f.db.prepare(getDefaultTestOeeDashboardSql(start,end,"overview").sql).get()!;
  close(overview["mt_oee_percent"],expectedMt*100); close(overview["overall_oee_percent"],expectedAll*100);
  const daily=f.db.prepare(getDefaultTestOeeSql(start,end).sql).all();
  for (const row of daily.filter((r)=>r["kind"]==="MT")) close(row["period_test_oee"],expectedMt);
  const cards=buildTypeOverviews(rows,{start,end});
  close(cards.find((c)=>c.id==="mt-oee-overview")!.data[0]!["overall_oee_percent"],expectedMt*100);
  const dashboard=calculateDefaultDashboard(f.db,end);
  for (const widget of dashboard.widgets.filter((w)=>w.id.startsWith("oee-trend-"))) {
    const populated=widget.data.filter((r)=>r["oee_percent"]!==null);
    assert.equal(populated.length,1); close(populated[0]!["oee_percent"],expectedAll*100);
  }
  for (const row of dashboard.widgets.find((w)=>w.id==="oee-extremes-table-2026")!.data) {
    close(row["oee_percent"],expectedAll*100);
    close(Number(row["availability_percent"])/100*Number(row["dut_on_percent"])/100*
      Number(row["test_time_percent"])/100*Number(row["yield_percent"])/100,expectedAll);
  }
  const summary=summarizePeriodOee(rows).find((r)=>r.kind==="MT")!;
  close(summary.metrics["test_oee"],expectedMt); assert.ok(!("means" in summary));
});

test("independent sources preserve DUT-only quantities and can calculate a period with no calculable days", (t) => {
  const f=fixture(t), start="2026-01-04", end="2026-01-05";
  f.a(start,50,100); f.d(end,80,40,100);
  const mt=f.rows(start,end).find((r)=>r["kind"]==="MT")!;
  close(mt["test_oee"],.2); assert.equal(mt["calculable_day_type_count"],0);
  assert.equal(mt["availability_day_type_count"],1); assert.equal(mt["dut_day_type_count"],1);
  const daily=f.db.prepare(getDefaultTestOeeSql(start,end).sql).all().filter((r)=>r["kind"]==="MT");
  assert.ok(daily.every((r)=>r["daily_test_oee"]===null));
  close(daily[1]!["dut_on"],.8); close(daily[1]!["final_yield"],.5);
  assert.ok(buildTypeOverviews(f.rows(start,end),{start,end})[1]!.warnings.some((w)=>w.includes("0/2")));
});

test("period trim is recomputed across days at 999/1000/2000 rows without clipping or removing totals", (t) => {
  for (const count of [999,1000,2000]) {
    const f=fixture(t), start="2026-01-04",end="2026-01-05";
    f.a(start,100,100); f.a(end,100,100);
    f.d(start,10,8,20,"MT",1); f.d(end,10,8,20,"MT",100);
    for(let i=2;i<count;i++) f.d(i%2?start:end,10,8,20);
    // A separate type has a very different standard and a DUT-only machine contributes normally.
    f.d(start,10,8,20,"ST",1000); f.a(start,100,100,"ST");
    const mt=f.rows(start,end,"week").find((r)=>r["kind"]==="MT")!;
    const seconds=count*10+81, expected=count<1000?1:count*10/seconds;
    close(mt["test_time_performance"],expected); assert.equal(mt["actual_test_seconds"],seconds);
    assert.equal(mt["touchdown_count"],count); assert.equal(mt["trimmed_rows_each_tail"],Math.floor(count/1000));
    const all=f.rows(start,end).find((r)=>r["kind"]==="ALL")!;
    close(all["test_time_performance"],((count<1000?seconds:count*10)+1000)/(seconds+1000));
    if(count===1000) {
      const daily=f.rows(start,end,"day").filter((r)=>r["kind"]==="MT");
      assert.ok(daily.every((r)=>r["test_time_performance"]===1)); assert.notEqual(mt["test_time_performance"],1);
    }
  }
  const f=fixture(t); f.a("2026-01-04",100,100); f.d("2026-01-04",10,8,20,"MT",10);
  f.d("2026-01-04",10,8,20,"MT",null);
  close(f.rows("2026-01-04").find((r)=>r["kind"]==="MT")!["test_time_performance"],2);
  close(f.db.prepare(getMachinePeriodTestOeeSql("2026-01-04","2026-01-04","day").sql).get()!["test_time_performance"],1);
});

test("combined Test Time keeps NULL if one populated type has an invalid required component", (t) => {
  const f=fixture(t), day="2026-01-04";
  f.a(day,100,100); f.d(day,80,40,100);
  f.a(day,100,100,"ST"); f.d(day,80,40,100,"ST",null);
  const rows=f.rows(day); close(rows.find((r)=>r["kind"]==="MT")!["test_oee"],.4);
  const all=rows.find((r)=>r["kind"]==="ALL")!;
  assert.equal(all["test_time_performance"],null); assert.equal(all["test_oee"],null); close(all["dut_on"],.8);
});

test("period bounds split years, preserve natural months and quarters, and retain empty calendar periods", (t) => {
  const f=fixture(t);
  for (const day of ["2025-12-31","2026-01-01","2026-01-04","2026-02-01","2026-04-01"]) {
    f.a(day,100,100); f.d(day,10,8,20);
  }
  const weeks=f.rows("2025-12-31","2026-01-04","week").filter((r)=>r["kind"]==="ALL");
  assert.deepEqual(weeks.map((r)=>[r["period_label"],r["period_start"],r["period_end"],r["is_partial_period"]]),[
    ["2025-W52","2025-12-31","2025-12-31",1],["2026-W00","2026-01-01","2026-01-03",1],
    ["2026-W01","2026-01-04","2026-01-04",1],
  ]);
  const months=f.rows("2026-01-01","2026-04-01","month").filter((r)=>r["kind"]==="ALL");
  assert.deepEqual(months.map((r)=>r["period_label"]),["2026-01","2026-02","2026-03","2026-04"]);
  assert.equal(months[2]!["test_oee"],null); assert.equal(months[2]!["availability_day_type_count"],0);
  assert.equal(months[0]!["is_partial_period"],0); assert.equal(months[3]!["is_partial_period"],1);
  const quarters=f.rows("2026-01-01","2026-04-01","quarter").filter((r)=>r["kind"]==="ALL");
  assert.deepEqual(quarters.map((r)=>[r["period_label"],r["is_partial_period"]]),[["2026-Q1",0],["2026-Q2",1]]);
});

test("pooled daily minimum uses combined source weights instead of averaging MT and ST", (t) => {
  const f=fixture(t), start="2026-01-04",end="2026-01-05";
  f.a(start,1,1); f.d(start,10,10,10); f.a(start,0,100,"ST"); f.d(start,1000,1000,1000,"ST");
  f.a(end,20,100); f.d(end,10,10,10); f.a(end,20,100,"ST"); f.d(end,10,10,10,"ST");
  const state=calculateDefaultDashboard(f.db,end);
  assert.deepEqual(minimumComparisonPeriod(state,f.rows(start,end,"day"),end,"day"),{start,end:start});
});

test("period tool exposes the shared pooled query and rejects invalid grains", async () => {
  const tool=createTools().find((t)=>t.name==="get_period_sql")!;
  const result=await tool.execute("period",{start_date:"2026-01-04",end_date:"2026-01-05",grain:"week"}, undefined, undefined, {} as never);
  assert.deepEqual(result.details,getPeriodTestOeeSql("2026-01-04","2026-01-05","week"));
  assert.throws(()=>getPeriodTestOeeSql("2026-01-04","2026-01-05","invalid" as MachinePeriodGrain));
});


test("all generated fleet views fit the interactive SQL validator", () => {
  const start = "2026-01-01", end = "2026-12-31";
  const queries = [getDefaultTestOeeSql(start, end),
    getDefaultTestOeeDashboardSql(start, end, "overview"), getDefaultTestOeeDashboardSql(start, end, "trends"),
    ...(["day", "week", "month", "quarter"] as const).map((grain) => getPeriodTestOeeSql(start, end, grain))];
  for (const query of queries) {
    assert.equal(query.periodAggregation, "pooled_components");
    assertReadOnlyQuery(query.sql);
  }
});

test("weekly extrema follow pooled weights and months split a week across its business days", (t) => {
  const f = fixture(t);
  f.a("2026-01-04", 1, 1); f.d("2026-01-04", 10, 10, 10);
  f.a("2026-01-04", 0, 100, "ST"); f.d("2026-01-04", 1000, 1000, 1000, "ST");
  for (const kind of ["MT", "ST"]) { f.a("2026-01-11", 20, 100, kind); f.d("2026-01-11", 10, 10, 10, kind); }
  const state = calculateDefaultDashboard(f.db, "2026-01-11");
  const low = state.widgets.find((w) => w.id === "oee-extremes-table-2026")!.data
    .find((r) => r["grain"] === "周" && r["point_type"] === "最低")!;
  assert.equal(low["period_label"], "2026-W01"); close(low["oee_percent"], 100 / 101);
  f.a("2026-04-30", 10, 100); f.d("2026-04-30", 10, 10, 20);
  f.a("2026-05-01", 90, 100); f.d("2026-05-01", 90, 90, 100);
  const weekly = f.rows("2026-04-30", "2026-05-01", "week").filter((r) => r["kind"] === "MT");
  assert.equal(weekly.length, 1); close(weekly[0]!["input_quantity"], 100);
  const months = f.rows("2026-04-30", "2026-05-01", "month").filter((r) => r["kind"] === "MT");
  assert.deepEqual(months.map((r) => [r["period_label"], r["input_quantity"]]), [["2026-04", 10], ["2026-05", 90]]);
});


test("Effective DUT-On is fixed at 89.5% across types, machine scopes and every period", (t) => {
  const f = fixture(t), start = "2026-01-04", end = "2026-02-05";
  for (const [day, mtInput, stInput] of [[start, 20, 80], [end, 80, 20]] as const) {
    f.a(day, 50, 100); f.d(day, mtInput, mtInput / 2, 100);
    f.a(day, 100, 100, "ST"); f.d(day, stInput, stInput / 2, 100, "ST");
  }
  for (const grain of ["day", "week", "month", "quarter", "report_period"] as const) {
    for (const row of f.rows(start, end, grain)) {
      assert.equal(row["effective_dut_on"], .895);
      if (row["effective_availability"] === null) assert.equal(row["effective_oee"], null);
      else {
        close(row["effective_oee"], Number(row["effective_availability"]) * .895 * .5);
        close(row["test_oee"], Number(row["availability"]) * Number(row["input_quantity"]) /
          Number(row["socket_quantity"]) * .5);
      }
    }
    if (grain !== "report_period") {
      const machines = f.db.prepare(getMachinePeriodTestOeeSql(start, end, grain).sql).all();
      for (const row of machines) {
        assert.equal(row["effective_dut_on"], .895);
        close(row["effective_oee"], Number(row["effective_availability"]) * .895 * .5);
      }
    }
  }
  for (const byKind of [true, false]) {
    for (const row of f.db.prepare(machinePeriodSql({ start, end }, byKind)).all()) {
      assert.equal(row["effective_dut_on"], 89.5);
      close(row["effective_oee"], Number(row["effective_availability"]) * .895 * .5);
    }
  }
  for (const row of f.db.prepare(getDefaultTestOeeSql(start, end).sql).all()) {
    assert.equal(row["effective_dut_on"], .895);
    close(row["period_effective_oee"], (row["kind"] === "MT" ? .5 : 1) * .895 * .5);
  }
  const overview = f.db.prepare(getDefaultTestOeeDashboardSql(start, end, "overview").sql).get()!;
  for (const prefix of ["mt", "st", "avg"]) assert.equal(overview[`${prefix}_effective_dut_on_percent`], 89.5);
  for (const row of f.db.prepare(getDefaultTestOeeDashboardSql(start, end, "trends").sql).all()) {
    assert.equal(row["mt_effective_dut_on_percent"], 89.5);
    assert.equal(row["st_effective_dut_on_percent"], 89.5);
  }
  for (const card of buildTypeOverviews(f.rows(start, end), { start, end })) {
    const expected = card.encoding.label === "Effective OEE" ? 89.5 : 50;
    close(card.data[0]![card.encoding.gauges[1]!.column], expected);
  }
});

test("fixed Effective DUT-On ignores zero or missing Sockets but preserves missing remaining factors", (t) => {
  const f = fixture(t), day = "2026-01-04";
  f.a(day, 50, 100); f.d(day, 80, 40, 0);
  for (const sockets of ["0", null]) {
    f.db.prepare("UPDATE oee_dut_utilization SET dut_num=?").run(sockets);
    const mt = f.rows(day).find((r) => r["kind"] === "MT")!;
    assert.equal(mt["dut_on"], null); assert.equal(mt["test_oee"], null);
    assert.equal(mt["effective_dut_on"], .895); close(mt["effective_oee"], .5 * .895 * .5);
    assert.equal(mt["calculable_day_type_count"], 0);
    assert.equal(mt["effective_calculable_day_type_count"], 1);
    const daily = f.db.prepare(getDefaultTestOeeSql(day, day).sql).get()!;
    assert.equal(daily["effective_calculable_day_count"], 1);
    close(daily["daily_effective_oee"], .5 * .895 * .5);
    for (const grain of ["day", "week", "month", "quarter"] as const) {
      const machine = f.db.prepare(getMachinePeriodTestOeeSql(day, day, grain).sql).get()!;
      assert.equal(machine["test_oee"], null); close(machine["effective_oee"], .5 * .895 * .5);
    }
  }
  for (const row of f.rows("2026-03-01")) {
    assert.equal(row["effective_dut_on"], .895); assert.equal(row["effective_oee"], null);
  }
  f.db.exec("UPDATE oee_dut_utilization SET end_time=NULL");
  assert.equal(f.rows(day).find((r) => r["kind"] === "MT")!["effective_oee"], null);
});
