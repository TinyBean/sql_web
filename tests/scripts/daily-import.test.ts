import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test, { type TestContext } from "node:test";
import { initializeOeeDatabase } from "../../scripts/database/initialize.ts";
import { loadDataCommandConfig } from "../../scripts/database/data-command-config.ts";
import { dailyUpdatePlan } from "../../scripts/database/daily-update.ts";
import { OeeDataStore, type OeeDataset } from "../../scripts/database/oee-data-store.ts";
import { runDailyUpdate } from "../../scripts/scheduling/daily-update.ts";
import { addDays } from "../../src/server/database/business-dates.ts";
import { DashboardRegistry } from "../../src/server/dashboard/index.ts";
import type { AppLogger } from "../../src/server/logger.ts";

const datasets = ["availability", "dut_utilization"] as const;
const tables = { availability: "oee_availability", dut_utilization: "oee_dut_utilization" } as const;

function rows(dataset: OeeDataset, date: string): Record<string, unknown>[] {
  return ["day", "night"].map((shift) => ({
    "ORPTSIP.DATE": date + "T00:00:00.000Z", "ORPTSIP.SHIFT": shift,
    "ORPTSIP.LOT_ID": date + shift, "ORPTSIP.TOOL_NAME": "MT-01",
    "ORPTSIP.FINAL_STATE": "Running", "ORPTSIP.STEP": "5000", "ORPTSIP.TIME_SPAN": 60,
    "ORPTSIP.MACHINE_ID": "MT-01", "ORPTSIP.IN_QTY": "100", "ORPTSIP.OUT_QTY": "99",
    "ORPTSIP.DUT_NUM": "192", "ORPTSIP.TEST_STAGE": "1st", "ORPTSIP.STEP_ID": "5000",
    "ORPTSIP.TEST_PROGRAM": dataset,
  }));
}

function response(dataset: OeeDataset, records: readonly Record<string, unknown>[]): string {
  const endpoint = dataset === "availability" ? "R_OEE_MT_TOP_AVAILABILITY_2W" : "R_OEE_MT_TOP_DUT_UTILIZATION_2W";
  return JSON.stringify({ [`ORPTSIP.${endpoint}Response`]: {
    [`ORPTSIP.${endpoint}Result`]: { "ORPTSIP.row": records },
  } });
}

async function fixture(t: TestContext) {
  const directory = mkdtempSync(path.join(tmpdir(), "daily-import-"));
  const config = loadDataCommandConfig(directory, {});
  initializeOeeDatabase(config.databasePath);
  const database = new DatabaseSync(config.databasePath);
  const requests: Array<{ dataset: OeeDataset; startDate: string; endDate: string }> = [];
  const overrides = new Map<string, { status: number; body: string }>();
  const logs: Array<{ event: string; fields: unknown }> = [];
  const logger: AppLogger = {
    info(event, fields) { logs.push({ event, fields }); }, warn() {}, error() {}, child() { return this; },
  };
  const server = createServer((request, reply) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    const dataset = url.pathname.includes("AVAILABILITY") ? "availability" : "dut_utilization";
    const dateKey = (key: string) => {
      const value = url.searchParams.get(key)!;
      return value.slice(0, 4) + "-" + value.slice(4, 6) + "-" + value.slice(6, 8);
    };
    const startDate = dateKey("pSTARTDAY");
    requests.push({ dataset, startDate, endDate: dateKey("pENDDAY") });
    const override = overrides.get(dataset + startDate);
    const sourceRows = (dataset === "availability" ? [startDate] : [addDays(startDate, -1), startDate, addDays(startDate, 1)])
      .flatMap((date) => rows(dataset, date));
    reply.writeHead(override?.status ?? 200, { "content-type": "application/json" });
    reply.end(override?.body ?? response(dataset, sourceRows));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const options = { ...config, apiBaseUrl: `http://127.0.0.1:${address.port}/`, fetchRetries: 0, logger };
  const analyses: Array<{ date: string; warnings: readonly string[] }> = [];
  const registry = new DashboardRegistry([{
    id: "default", loadInitial() { assert.fail("daily update must use its update entry"); },
    async update(context) {
      analyses.push({ date: context.throughDate, warnings: context.syncWarnings });
      return { status: "completed", published: true, dataAsOf: context.now.toISOString(), reason: null };
    },
  }]);
  t.after(async () => {
    database.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(directory, { recursive: true, force: true });
  });
  return {
    database, options, requests, overrides, analyses, logs,
    run(date: string) {
      return runDailyUpdate(options, dailyUpdatePlan([], new Date(addDays(date, 1) + "T01:00:00Z")), registry, logger);
    },
    facts(dataset: OeeDataset) { return database.prepare(`SELECT * FROM ${tables[dataset]} ORDER BY id`).all(); },
  };
}

test("daily imports only new target dates, preserving historical gaps, facts, and DUT boundaries", async (t) => {
  const f = await fixture(t);
  f.database.prepare("INSERT INTO oee_availability(tool_name,lot_id,final_state,step,date,time_span) VALUES('old','old','Running','5000','2026-10-06T00:00:00.000Z',60)").run();
  f.database.prepare("INSERT INTO oee_dut_utilization(machine_id,lot_id,in_qty,out_qty,test_stage,dut_num,step_id,date,shift) VALUES('old','old','10','9','1st','20','5000','2026-10-07T00:00:00.000Z','night')").run();
  const before = datasets.map((dataset) => f.facts(dataset));
  assert.equal((await f.run("2026-10-08")).status, "completed");
  const afterFirst = datasets.map((dataset) => f.facts(dataset));
  const repeated = await f.run("2026-10-08");
  assert.equal(repeated.status, "completed");
  assert.ok(repeated.database.datasets.every((dataset) =>
    dataset.result?.datasets[0]?.plannedWindows.length === 0 && dataset.result.datasets[0]?.imports.length === 0));
  assert.deepEqual(datasets.map((dataset) => f.facts(dataset)), afterFirst);
  assert.ok(f.logs.some((entry) => entry.event === "oee.new_day.skipped"));
  assert.equal((await f.run("2026-10-09")).status, "completed");
  assert.deepEqual(f.requests, [
    { dataset: "availability", startDate: "2026-10-08", endDate: "2026-10-08" },
    { dataset: "dut_utilization", startDate: "2026-10-08", endDate: "2026-10-10" },
    { dataset: "availability", startDate: "2026-10-09", endDate: "2026-10-09" },
    { dataset: "dut_utilization", startDate: "2026-10-09", endDate: "2026-10-11" },
  ]);
  assert.deepEqual(f.analyses.map((analysis) => analysis.date), ["2026-10-08", "2026-10-08", "2026-10-09"]);
  for (const [index, dataset] of datasets.entries()) {
    const facts = f.facts(dataset);
    assert.deepEqual(facts.slice(0, before[index]!.length), before[index]);
    assert.deepEqual(facts.slice(0, afterFirst[index]!.length), afterFirst[index]);
    assert.equal(facts.length, 5);
  }
});

test("same-day retries only an uncommitted dataset, then advances without retrying a historical missing date", async (t) => {
  const f = await fixture(t);
  f.overrides.set("dut_utilization2026-10-08", { status: 200, body: response("dut_utilization", []) });
  const first = await f.run("2026-10-08");
  assert.equal(first.status, "completed_with_warnings");
  assert.equal(first.dashboards[0]?.published, true);
  assert.equal(f.analyses[0]?.warnings.length, 1);
  const availability = f.facts("availability");
  await f.run("2026-10-08");
  assert.deepEqual(f.facts("availability"), availability);
  await f.run("2026-10-09");
  assert.deepEqual(f.requests.map(({ dataset, startDate }) => [dataset, startDate]), [
    ["availability", "2026-10-08"], ["dut_utilization", "2026-10-08"],
    ["dut_utilization", "2026-10-08"], ["availability", "2026-10-09"], ["dut_utilization", "2026-10-09"],
  ]);
  assert.deepEqual(f.database.prepare("SELECT DISTINCT substr(date,1,10) date FROM oee_dut_utilization").all()
    .map((row) => row["date"]), ["2026-10-09"]);
});

test("daily target dates and DUT request padding cross month and year boundaries without refreshing", async (t) => {
  for (const [first, second] of [["2026-10-31", "2026-11-01"], ["2026-12-31", "2027-01-01"]]) {
    const f = await fixture(t);
    await f.run(first!);
    const before = datasets.map((dataset) => f.facts(dataset));
    await f.run(second!);
    assert.deepEqual(f.requests, [first!, second!].flatMap((date) => [
      { dataset: "availability", startDate: date, endDate: date },
      { dataset: "dut_utilization", startDate: date, endDate: addDays(date, 2) },
    ]));
    for (const [index, dataset] of datasets.entries()) {
      assert.deepEqual(f.facts(dataset).slice(0, before[index]!.length), before[index]);
    }
  }
});

test("daily failures roll back facts and retain existing analysis failure handling", async (t) => {
  for (const failure of ["parse", "write"] as const) {
    const f = await fixture(t);
    f.database.prepare("INSERT INTO oee_dut_utilization(machine_id,lot_id,in_qty,out_qty,test_stage,dut_num,step_id,date,shift) VALUES('old','old','10','9','1st','20','5000','2026-10-08T00:00:00.000Z','day')").run();
    const before = f.facts("dut_utilization");
    if (failure === "parse") {
      f.overrides.set("dut_utilization2026-10-08", { status: 200, body: response("dut_utilization", rows("dut_utilization", "2026-10-08")).slice(0, -1) });
    } else {
      f.database.exec("CREATE TRIGGER reject_dut BEFORE INSERT ON oee_dut_utilization BEGIN SELECT RAISE(ABORT,'write failure'); END");
    }
    const result = await f.run("2026-10-08");
    assert.equal(result.status, "failed");
    assert.equal(result.dashboards[0]?.status, "skipped");
    assert.equal(f.analyses.length, 0);
    assert.deepEqual(f.facts("dut_utilization"), before);
    if (failure === "parse") f.overrides.delete("dut_utilization2026-10-08");
    else f.database.exec("DROP TRIGGER reject_dut");
    assert.equal((await f.run("2026-10-08")).status, "completed");
    assert.deepEqual(f.requests.slice(2).map(({ dataset, startDate }) => [dataset, startDate]), [["dut_utilization", "2026-10-08"]]);
  }
});

test("new-day imports preserve old shifts when an untracked target's coverage regresses", async (t) => {
  const f = await fixture(t);
  f.database.prepare("INSERT INTO oee_dut_utilization(machine_id,lot_id,in_qty,out_qty,test_stage,dut_num,step_id,date,shift) VALUES('old','old','10','9','1st','20','5000','2026-10-08T00:00:00.000Z','night')").run();
  const before = f.facts("dut_utilization");
  f.overrides.set("dut_utilization2026-10-08", { status: 200, body: response("dut_utilization", rows("dut_utilization", "2026-10-08").slice(0, 1)) });
  const result = await f.run("2026-10-08");
  assert.equal(result.status, "completed_with_warnings");
  assert.deepEqual(f.facts("dut_utilization"), before);
  assert.equal(f.analyses.length, 1);
});

test("successful committed dates skip even with warnings or a later failed attempt, but legacy DUT dates do not", async (t) => {
  const f = await fixture(t);
  const store = OeeDataStore.open(f.options);
  try {
    f.overrides.set("dut_utilization2026-10-08", { status: 200, body: response("dut_utilization", [
      ...rows("dut_utilization", "2026-10-08"), ...rows("dut_utilization", "2026-10-15"),
    ]) });
    assert.equal((await store.importNewDay({ dataset: "dut_utilization", date: "2026-10-08" })).status, "completed_with_warnings");
    const before = f.facts("dut_utilization");
    f.overrides.set("dut_utilization2026-10-08", { status: 200, body: "invalid JSON" });
    assert.equal((await store.sync({ dataset: "dut_utilization", initialStartDate: "2026-10-08", throughDate: "2026-10-08" })).status, "failed");
    const skipped = await store.importNewDay({ dataset: "dut_utilization", date: "2026-10-08" });
    assert.equal(skipped.status, "completed");
    assert.deepEqual(skipped.datasets[0]?.imports, []);
    assert.equal(f.requests.length, 2);
    assert.deepEqual(f.facts("dut_utilization"), before);
    f.database.prepare("UPDATE oee_import_windows SET coverage_version=0,committed_dates_json='[]' WHERE dataset='dut_utilization' AND status='completed_with_warnings'").run();
    f.overrides.delete("dut_utilization2026-10-08");
    assert.equal((await store.importNewDay({ dataset: "dut_utilization", date: "2026-10-08" })).datasets[0]?.imports.length, 1);
    assert.equal(f.requests.length, 3);
  } finally { store.close(); }
});

test("legacy Availability commits are recognized per date, excluding missing days", async (t) => {
  const f = await fixture(t);
  const store = OeeDataStore.open(f.options);
  try {
    f.overrides.set("availability2026-10-07", { status: 200, body: response("availability", rows("availability", "2026-10-07")) });
    await store.sync({ dataset: "availability", initialStartDate: "2026-10-07", throughDate: "2026-10-08" });
    f.database.exec("UPDATE oee_import_windows SET coverage_version=0,committed_dates_json='[]'");
    assert.deepEqual((await store.importNewDay({ dataset: "availability", date: "2026-10-07" })).datasets[0]?.plannedWindows, []);
    assert.equal((await store.importNewDay({ dataset: "availability", date: "2026-10-08" })).datasets[0]?.imports.length, 1);
    assert.deepEqual(f.requests.map(({ startDate, endDate }) => [startDate, endDate]), [
      ["2026-10-07", "2026-10-08"], ["2026-10-08", "2026-10-08"],
    ]);
    await assert.rejects(store.importNewDay({ dataset: "availability", date: "2026-02-30" }), /有效日期/u);
  } finally { store.close(); }
});
