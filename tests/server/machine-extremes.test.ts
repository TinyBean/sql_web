import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test, { type TestContext } from "node:test";
import { buildMachineExtremesTable } from "../../src/server/dashboard/default/machine-extremes.ts";

function fixture(t: TestContext) {
  const database = new DatabaseSync(":memory:");
  database.exec(readFileSync(path.join(process.cwd(), "scripts/database/schema.sql"), "utf8"));
  t.after(() => database.close());
  const availability = database.prepare(
    "INSERT INTO oee_availability(tool_name,date,time_span,step,final_state,lot_id) VALUES(?,?,?,?,?,?)",
  );
  const dut = database.prepare(
    "INSERT INTO oee_dut_utilization(machine_id,date,in_qty,out_qty,dut_num,step_id,lot_id,test_stage,touchdown_index,start_time,end_time) VALUES(?,?,?,?,?,?,?,?,'1','2026-01-01T00:00:00.000Z','2026-01-01T00:00:10.000Z')",
  );
  return {
    database,
    a(machine: string, day: string, seconds: number, step = "5000", state = "Test(Normal)", lot = "P-LOT") {
      availability.run(machine, day, seconds, step, state, lot);
    },
    d(machine: string, day: string, input: number | string, output: number | string, sockets: number | string,
      step = "5000", lot = "P-LOT", stage = "1st") {
      dut.run(machine, day, String(input), String(output), String(sockets), step, lot, stage);
    },
  };
}

const monthRange = { start: "2026-01-01", end: "2026-01-31" };
const monthLow = { grain: "月", point_type: "最低", period_label: "2026-01", oee_percent: 55.55 };

test("machine test time shares each daily type standard including DUT without Availability", (t) => {
  const { database, a, d } = fixture(t);
  for (const day of ["2026-01-01", "2026-01-02"]) {
    for (const machine of ["A", "B"]) {
      a(machine, day, 43200); d(machine, day, 10, 10, 10);
    }
  }
  d("DUT-ONLY", "2026-01-01", 10, 10, 10);
  database.exec(`UPDATE oee_dut_utilization SET end_time = CASE
    WHEN date='2026-01-02' THEN '2026-01-01T00:00:20.000Z'
    WHEN machine_id='B' THEN '2026-01-01T00:00:30.000Z'
    WHEN machine_id='DUT-ONLY' THEN '2026-01-01T00:00:50.000Z'
    ELSE end_time END`);
  // Standards: Jan 1 = 30s; Jan 2 = 20s. Each machine's standard total is 50s.
  const table = buildMachineExtremesTable(database, [monthLow], monthRange);
  assert.equal(table.data[0]!["top10_machines"], "1.B(MT 50.00%)、2.A(MT 83.33%)");
  database.exec("UPDATE oee_dut_utilization SET end_time=NULL WHERE date='2026-01-02'");
  assert.equal(buildMachineExtremesTable(database, [monthLow], monthRange).data[0]!["top10_machines"], null);
});

test("machine rankings aggregate the whole period, merge types and include end-day timestamps and DUT-only days", (t) => {
  const { database, a, d } = fixture(t);
  a("A", "2026-01-30", 21600);
  a("A", "2026-01-30", 21600, "7000");
  a("A", "2026-01-31T00:00:00.000Z", 86400, "7000");
  d("A", "2026-01-30", 10, 5, 20, "7000");
  d("A", "2026-01-31T00:00:00.000Z", 90, 45, 90, "5000", "P-LOT", "Rescreen");
  a("B", "2026-01-30", 21600);
  a("B", "2026-01-30", 21600, "7000");
  d("B", "2026-01-30", 100, 100, 200);
  a("END", "2026-01-30", 43200);
  d("END", "2026-01-30", 10, 10, 10);
  d("END", "2026-01-31T00:00:00.000Z", 10, 0, 90);
  // Neither side of the closed period may leak into the monthly ranking.
  a("END", "2025-12-31", 86400);
  d("END", "2025-12-31", 1000, 1000, 1000);
  a("END", "2026-02-01T00:00:00.000Z", 86400);
  d("END", "2026-02-01T00:00:00.000Z", 1000, 1000, 1000);

  const table = buildMachineExtremesTable(database, [monthLow], monthRange, ["同步缺日提示"]);
  assert.deepEqual(table.data, [{
    ...monthLow, top10_machines: "1.END(MT 5.00%)、2.B(MT 25.00%)、3.A(ST 34.09%)",
  }]);
  assert.ok(table.warnings.includes("同步缺日提示"));
  assert.match(table.warnings.join(" "), /Availability 覆盖 1–2\/31 天，DUT 覆盖 1–2\/31 天/u);
});

test("rankings exclude invalid and missing inputs, preserve zero OEE, and reuse canonical classification", (t) => {
  const { database, a, d } = fixture(t);
  for (const machine of ["LOSS", "MISSING", "ZERO-SOCKETS", "ZERO-INPUT", "BLANK", "TSPH001", "BAD-LOT", "UNKNOWN", "ADH175"]) {
    a(machine, "2026-01-01", 43200, machine === "UNKNOWN" || machine === "ADH175" ? "x" : "5000",
      machine === "LOSS" ? "Assistance" : "Test(Normal)", machine === "BAD-LOT" ? "None" : "P-LOT");
    if (machine !== "MISSING") {
      d(machine, "2026-01-01", machine === "ZERO-INPUT" ? 0 : 10, machine === "BLANK" ? " " : 10,
        machine === "ZERO-SOCKETS" ? 0 : 20, machine === "UNKNOWN" || machine === "ADH175" ? "x" : "5000",
        machine === "BAD-LOT" ? "None" : "P-LOT");
    }
  }
  d("DUT-ONLY", "2026-01-01", 10, 10, 20);
  // Type is determined by all Availability time, including loss states.
  a("TYPE", "2026-01-01", 43200);
  a("TYPE", "2026-01-02", 86400, "7000", "Assistance");
  d("TYPE", "2026-01-01", 10, 10, 20);

  const table = buildMachineExtremesTable(database, [monthLow], monthRange);
  assert.equal(table.data[0]?.["top10_machines"], "1.LOSS(MT 0.00%)、2.TYPE(ST 12.50%)、3.ADH175(ST 25.00%)");
  assert.match(table.warnings.join(" "), /可计算机台 3\/7，展示 3 台/u);
});

test("top ten uses unrounded OEE, then machine identifiers for ties, and never clamps source values", (t) => {
  const { database, a, d } = fixture(t);
  for (const [machine, output] of [["A", 20.004], ["Z", 20.003], ["TIE-B", 30], ["TIE-A", 30]] as const) {
    a(machine, "2026-01-01", 86400);
    d(machine, "2026-01-01", 100, output, 100);
  }
  for (let i = 1; i <= 7; i++) {
    a("HIGH-" + i, "2026-01-01", 86400);
    d("HIGH-" + i, "2026-01-01", 100, 100 + i, 100);
  }
  const table = buildMachineExtremesTable(database, [monthLow], monthRange);
  const list = String(table.data[0]?.["top10_machines"]).split("、");
  assert.equal(list.length, 10);
  assert.deepEqual(list.slice(0, 4), ["1.Z(MT 20.00%)", "2.A(MT 20.00%)", "3.TIE-A(MT 30.00%)", "4.TIE-B(MT 30.00%)"]);
  assert.equal(list.at(-1), "10.HIGH-6(MT 106.00%)");
});

test("rows follow grain and low/high order, preserve fleet OEE, and clip W00 and current periods to the dashboard range", (t) => {
  const { database, a, d } = fixture(t);
  a("PREVIOUS", "2026-12-31", 86400);
  d("PREVIOUS", "2026-12-31", 100, 1, 100);
  a("CURRENT", "2027-01-01T00:00:00.000Z", 43200);
  d("CURRENT", "2027-01-01T00:00:00.000Z", 10, 8, 20);
  a("FUTURE", "2027-01-02", 86400);
  d("FUTURE", "2027-01-02", 100, 1, 100);
  const extremes = ["季", "月", "周"].flatMap((grain) => ["最高", "最低"].map((point_type) => ({
    grain, point_type, period_label: grain === "季" ? "2027-Q1" : grain === "月" ? "2027-01" : "2027-W00",
    oee_percent: 51.23,
  })));
  const table = buildMachineExtremesTable(database, extremes, { start: "2027-01-01", end: "2027-01-01" });
  assert.deepEqual(table.data.map((row) => [row["grain"], row["point_type"]]), [
    ["周", "最低"], ["周", "最高"], ["月", "最低"], ["月", "最高"], ["季", "最低"], ["季", "最高"],
  ]);
  for (const row of table.data) {
    assert.equal(row["oee_percent"], 51.23);
    assert.equal(row["top10_machines"], "1.CURRENT(MT 20.00%)");
  }
  assert.match(table.warnings.join(" "), /2027-01-01 至 2027-01-01/u);
  assert.equal(table.warnings.length, 3, "shared high/low periods should share coverage notes");
});

test("empty extrema and periods without calculable machines stay empty rather than inventing rankings", (t) => {
  const { database } = fixture(t);
  assert.deepEqual(buildMachineExtremesTable(database, [], monthRange).data, []);
  const table = buildMachineExtremesTable(database, [monthLow], monthRange);
  assert.equal(table.data[0]?.["top10_machines"], null);
  assert.match(table.warnings.join(" "), /可计算机台 0\/0，展示 0 台/u);
  assert.doesNotMatch(table.warnings.join(" "), /Infinity|NaN/u);
  assert.throws(() => buildMachineExtremesTable(database, [monthLow], {
    start: "2027-01-01", end: "2027-01-31",
  }), /周期不在看板日期范围内/u);
});
