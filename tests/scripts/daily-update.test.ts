import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test, { type TestContext } from "node:test";
import { initializeOeeDatabase } from "../../scripts/database/initialize.ts";
import { buildDefaultDashboard } from "../../src/server/dashboard/default/build.ts";
import { loadDataCommandConfig } from "../../scripts/database/data-command-config.ts";
import { dailyUpdatePlan } from "../../scripts/database/daily-update.ts";
import { runDailyUpdate } from "../../scripts/scheduling/daily-update.ts";
import { DashboardRegistry } from "../../src/server/dashboard/registry.ts";
import { createDefaultDashboardDefinition } from "../../src/server/dashboard/default/index.ts";
import { dashboardPeriods, weekLabel } from "../../src/server/dashboard/default/periods.ts";
import { addDays, latestClosedBusinessDate, latestCompleteWeek } from "../../src/server/database/business-dates.ts";
import { createDefaultDashboard } from "../../src/server/dashboard/default/template.ts";
import type { DashboardRow } from "../../src/shared/dashboard.ts";
import type { AppLogger } from "../../src/server/logger.ts";
import type { SyncOptions, SyncResult } from "../../scripts/database/oee-data-store.ts";

const logger: AppLogger = {
  info() {}, warn() {}, error() {}, child() { return this; },
};

function fixture(t: TestContext) {
  const directory = mkdtempSync(path.join(tmpdir(), "daily-oee-"));
  const config = loadDataCommandConfig(directory, {});
  initializeOeeDatabase(config.databasePath);
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return { directory, config };
}

function seed(database: DatabaseSync, date: string, kind = "MT", sockets = 20): void {
  const step = kind === "MT" ? "5000" : "7000";
  database.prepare(
    "INSERT INTO oee_availability(tool_name,lot_id,final_state,step,date,time_span) VALUES(?,?,?,?,?,?)",
  ).run(kind + "-01", "P-LOT", "Test(Normal)", step, date, 43_200);
  database.prepare(
    "INSERT INTO oee_dut_utilization(machine_id,lot_id,in_qty,out_qty,test_stage,dut_num,step_id,date,touchdown_index,start_time,end_time) VALUES(?,?,?,?,?,?,?,?,'1','2026-01-01T00:00:00.000Z','2026-01-01T00:00:10.000Z')",
  ).run(kind + "-01", "P-LOT", "10", "8", "1st", String(sockets), step, date);
}

test("resolves closed business dates at 08:30 and across month, year, and leap day", () => {
  for (const [instant, expected] of [
    ["2026-09-15T00:29:59Z", "2026-09-13"],
    ["2026-09-15T00:30:00Z", "2026-09-14"],
    ["2026-09-16T01:00:00Z", "2026-09-15"],
    ["2027-01-01T01:00:00Z", "2026-12-31"],
    ["2027-01-02T01:00:00Z", "2027-01-01"],
    ["2028-03-01T01:00:00Z", "2028-02-29"],
  ]) assert.equal(latestClosedBusinessDate(new Date(instant!)), expected);
  assert.throws(() => dashboardPeriods("2026-02-29"), /无效日期/u);
  assert.throws(() => dailyUpdatePlan(["--through-date", "2026-09-15"], new Date("2026-09-15T01:00:00Z")), /已结束/u);
  assert.throws(() => dailyUpdatePlan(["--through-date"]), /用法/u);
  assert.throws(() => dailyUpdatePlan(["--bad"]), /用法/u);
});

test("aligns the two API ranges and includes the previous year's complete week", () => {
  const plan = dailyUpdatePlan(["--dry-run"], new Date("2027-01-02T01:00:00Z"));
  assert.equal(plan.dryRun, true);
  assert.equal(plan.syncStart, "2026-12-20");
  assert.deepEqual(dashboardPeriods(plan.throughDate).trend, { start: "2027-01-01", end: "2027-01-01" });
  assert.deepEqual(dashboardPeriods(plan.throughDate).week, { start: "2026-12-20", end: "2026-12-26" });
  assert.deepEqual(plan.requests, [
    { dataset: "availability", initialStartDate: "2026-12-20", throughDate: "2027-01-01", overlapDays: 2 },
    { dataset: "dut_utilization", initialStartDate: "2026-12-21", throughDate: "2027-01-02", overlapDays: 2 },
  ]);
  assert.deepEqual(dashboardPeriods("2026-09-13").week, { start: "2026-09-06", end: "2026-09-12" });
});

test("complete weeks end on Saturday and keep business-day and year boundaries", () => {
  for (const [throughDate, start, end] of [
    ["2026-09-11", "2026-08-30", "2026-09-05"],
    ["2026-09-12", "2026-09-06", "2026-09-12"],
    ["2026-09-13", "2026-09-06", "2026-09-12"],
    ["2026-09-16", "2026-09-06", "2026-09-12"],
    ["2026-09-19", "2026-09-13", "2026-09-19"],
    ["2026-01-03", "2025-12-28", "2026-01-03"],
    ["2026-01-04", "2025-12-28", "2026-01-03"],
    ["2028-03-04", "2028-02-27", "2028-03-04"],
  ] as const) assert.deepEqual(latestCompleteWeek(throughDate), { start, end });
  assert.deepEqual(latestCompleteWeek(latestClosedBusinessDate(new Date("2026-09-13T00:29:59Z"))),
    { start: "2026-08-30", end: "2026-09-05" });
  assert.deepEqual(latestCompleteWeek(latestClosedBusinessDate(new Date("2026-09-13T00:30:00Z"))),
    { start: "2026-09-06", end: "2026-09-12" });
});

test("week labels match SQLite %U including years beginning on Monday and Sunday", () => {
  const database = new DatabaseSync(":memory:");
  try {
    const label = database.prepare("SELECT strftime('%Y-W%U', ?) AS label");
    for (const year of [2023, 2024, 2026, 2027, 2028]) {
      for (let day = year + "-01-01"; day <= year + "-12-31"; day = addDays(day, 1)) {
        assert.equal(weekLabel(day), label.get(day)?.["label"]);
      }
    }
  } finally { database.close(); }
  assert.equal(weekLabel("2026-09-06"), "2026-W36");
  assert.equal(weekLabel("2026-09-12"), "2026-W36");
  assert.equal(weekLabel("2026-09-13"), "2026-W37");
});

test("generates ten live cards using canonical calculations, stable extrema, and empty analysis placeholders", (t) => {
  const { config } = fixture(t);
  const writer = new DatabaseSync(config.databasePath);
  for (const day of ["2026-01-01", "2026-01-08"]) {
    seed(writer, day);
    seed(writer, day, "ST");
  }
  seed(writer, "2026-01-02", "MT", 0);
  const insert = writer.prepare("INSERT INTO oee_availability(tool_name,lot_id,final_state,step,date,time_span) VALUES(?,?,?,?,?,?)");
  for (const [state, seconds] of [["Assistance", 7200], ["HangUp", 3600], ["IDLE_NoWIP", 1800]] as const) {
    insert.run("MT-01", "P-LOT", state, "5000", "2026-01-01", seconds);
  }
  insert.run("TSPH001", "P-LOT", "Test(Normal)", "5000", "2026-01-01", 999999);
  insert.run("EXCLUDED", "None", "Test(Normal)", "5000", "2026-01-01", 999999);
  writer.close();
  const state = buildDefaultDashboard(config.databasePath, "2026-01-08", new Date("2026-01-09T01:00:00Z"));
  assert.deepEqual(state.widgets.map((widget) => [widget.id, widget.size]), createDefaultDashboard().widgets.map((widget) => [widget.id, widget.size]));
  assert.deepEqual(state.dateRange, { start: "2026-01-01", end: "2026-01-08" });
  assert.equal(state.dataAsOf, "2026-01-09T01:00:00.000Z");
  const overview = state.widgets[0]!;
  assert.ok(overview.kind === "overview");
  assert.equal(overview.data[0]?.["overall_oee_percent"], 20);
  assert.match(overview.encoding.description ?? "", /2\/8/u);
  assert.ok(overview.warnings.some((warning) => warning.includes("NULL")));
  const weekly = state.widgets[2]!;
  assert.deepEqual(weekly.data.map((row) => [row["period_label"], row["oee_percent"], row["max_point"], row["min_point"]]), [
    ["2026-W00", 20, 20, 20], ["2026-W01", 20, null, null],
  ]);
  assert.equal(state.widgets[5]?.data.length, 6);
  const machines = state.widgets[6]!;
  assert.equal(machines.kind, "table");
  assert.deepEqual(machines.data.map((row) => [row["grain"], row["point_type"]]), [
    ["周", "最低"], ["周", "最高"], ["月", "最低"], ["月", "最高"], ["季", "最低"], ["季", "最高"],
  ]);
  for (const row of machines.data) {
    const extreme: DashboardRow | undefined = state.widgets[5]!.data.find((item) =>
      item["grain"] === row["grain"] && item["point_type"] === row["point_type"]);
    assert.equal(row["period_label"], extreme?.["period_label"]);
    assert.equal(row["oee_percent"], extreme?.["oee_percent"]);
    assert.match(String(row["top10_machines"]), /^1\.ST-01\(ST 20\.00%\)、2\.MT-01\(MT /u);
  }
  const actions = state.widgets[7]!;
  assert.deepEqual(actions.data, []);
  assert.ok(actions.warnings.some((warning) => warning.includes("本次分析暂不可用")));
  assert.match(actions.subtitle ?? "", /2025-12-28 至 2026-01-03/u);
  assert.doesNotMatch(JSON.stringify(state), /W36|09-14|484\/514/u);
});

test("weekly trends, extrema, machine rankings and complete-week analysis share Sunday boundaries", (t) => {
  const { config } = fixture(t);
  const writer = new DatabaseSync(config.databasePath);
  seed(writer, "2026-01-03", "MT", 20); // Saturday: W00, 20%
  seed(writer, "2026-01-04", "MT", 40); // Sunday: W01, 10%
  seed(writer, "2026-01-10", "MT", 10); // Saturday: W01, 40%
  seed(writer, "2026-01-11", "MT", 80); // Sunday: W02, 5%
  writer.close();

  const state = buildDefaultDashboard(config.databasePath, "2026-01-11");
  const weekly = state.widgets[2]!;
  assert.deepEqual(weekly.data.map((row) => [row["period_label"], row["oee_percent"], row["max_point"], row["min_point"]]), [
    ["2026-W00", 20, null, null], ["2026-W01", 25, 25, null], ["2026-W02", 5, null, 5],
  ]);
  assert.equal(weekly.warnings.find((warning) => warning.startsWith("部分周：")),
    "部分周：2026-W00、2026-W02；与完整周期比较时需注意覆盖天数");
  assert.match(weekly.metricDefinition, /周日至周六/u);
  const extremes = state.widgets[5]!.data.filter((row) => row["grain"] === "周");
  assert.deepEqual(extremes.map((row) => [row["point_type"], row["period_label"], row["oee_percent"]]), [
    ["最高", "2026-W01", 25], ["最低", "2026-W02", 5],
  ]);
  const machines = state.widgets[6]!;
  assert.deepEqual(machines.data.filter((row) => row["grain"] === "周").map((row) => [
    row["period_label"], row["top10_machines"],
  ]), [["2026-W02", "1.MT-01(MT 5.00%)"], ["2026-W01", "1.MT-01(MT 16.00%)"]]);
  assert.ok(machines.warnings.some((warning) => warning.includes("2026-W01（2026-01-04 至 2026-01-10）")));
  assert.ok(machines.warnings.some((warning) => warning.includes("2026-W02（2026-01-11 至 2026-01-11）")));
  assert.match(state.widgets[7]!.subtitle, /最近完整周 · 2026-01-04 至 2026-01-10/u);
});

test("daily overview SQL feeds separate MT/ST metrics and excludes uncomputable days", (t) => {
  const { config } = fixture(t);
  const writer = new DatabaseSync(config.databasePath);
  seed(writer, "2026-01-01", "MT", 20);
  seed(writer, "2026-01-01", "ST", 40);
  seed(writer, "2026-01-02", "MT", 0);
  writer.close();
  const state = buildDefaultDashboard(config.databasePath, "2026-01-02");
  assert.deepEqual(state.widgets.slice(0, 2).map((widget) => widget.data[0]), [
    { overall_oee_percent: 20, avg_availability_percent: 50, avg_performance_percent: 50, avg_dut_on_percent: 50, avg_test_time_percent: 100, avg_yield_percent: 80 },
    { overall_oee_percent: 10, avg_availability_percent: 50, avg_performance_percent: 25, avg_dut_on_percent: 25, avg_test_time_percent: 100, avg_yield_percent: 80 },
  ]);
});

test("empty and cross-year dashboards contain null metrics and accurate period warnings", (t) => {
  const { config } = fixture(t);
  const empty = buildDefaultDashboard(config.databasePath, "2027-01-01");
  assert.equal(empty.widgets.length, 10);
  assert.equal(empty.widgets[0]?.data[0]?.["overall_oee_percent"], null);
  assert.equal(empty.widgets[5]?.data.length, 0);
  assert.equal(empty.widgets[6]?.kind, "table");
  assert.deepEqual(empty.widgets[6]?.data, []);
  assert.equal(empty.widgets[7]?.data.length, 0);
  assert.ok(empty.widgets[0]?.warnings.some((warning) => warning.includes("2027-01-01")));
  assert.equal(empty.widgets[2]?.data[0]?.["period_label"], "2027-W00");
  assert.match(empty.widgets[7]!.subtitle, /2026-12-20 至 2026-12-26/u);
  assert.match(empty.widgets[2]!.title, /2027/u);
  assert.match(empty.widgets[8]!.warnings.join(" "), /部分月/u);
});

function result(status: SyncResult["status"], dataset: "availability" | "dut_utilization"): SyncResult {
  return { runId: dataset, status, datasets: [{ dataset, plannedWindows: [], imports: [] }] };
}

test("hard sync failures preserve the published default and still attempt the other dataset", async (t) => {
  const { config } = fixture(t);
  writeFileSync(config.defaultDashboardPath, "old snapshot");
  const requests: SyncOptions[] = [];
  let closed = false;
  const registry = new DashboardRegistry([createDefaultDashboardDefinition(config, {
    async generate() { assert.fail("must not build"); },
    publish() { assert.fail("must not publish"); },
  })]);
  const outcome = await runDailyUpdate(config, dailyUpdatePlan([], new Date("2026-09-15T01:00:00Z")), registry, logger, {
    openStore: () => ({
      async sync(options) {
        requests.push(options);
        if (options.dataset === "availability") throw new Error("API unavailable");
        return result("completed", "dut_utilization");
      },
      close() { closed = true; },
    }),
  });
  assert.equal(closed, true);
  assert.equal(requests.length, 2);
  assert.equal(outcome.status, "failed");
  assert.equal(outcome.dashboards[0]?.published, false);
  assert.equal(outcome.dashboards[0]?.status, "skipped");
  assert.equal(readFileSync(config.defaultDashboardPath, "utf8"), "old snapshot");
});

test("sync warnings publish all ten cards with data coverage warnings", async (t) => {
  const { config } = fixture(t);
  let published = false;
  const registry = new DashboardRegistry([createDefaultDashboardDefinition(config, {
    async generate(config, date, now, warnings) {
      return { state: buildDefaultDashboard(config.databasePath, date, now, warnings),
        analysisStatus: "completed", analysisReason: null, analysisRunId: "test", analysisArtifactDir: "test" };
    },
    publish(filePath, state) {
      assert.equal(filePath, config.defaultDashboardPath);
      assert.equal(state.widgets.length, 10);
      assert.ok(state.widgets[0]?.warnings.some((warning) => warning.includes("同步存在")));
      published = true;
    },
  })]);
  const outcome = await runDailyUpdate(config, dailyUpdatePlan([], new Date("2026-09-15T01:00:00Z")), registry, logger, {
    openStore: () => ({
      async sync(options) { return result("completed_with_warnings", options.dataset as "availability" | "dut_utilization"); },
      close() {},
    }),
  });
  assert.equal(outcome.status, "completed_with_warnings");
  assert.equal(published, true);
});

test("calculation failures never publish a partial dashboard", async (t) => {
  const { config } = fixture(t);
  const registry = new DashboardRegistry([createDefaultDashboardDefinition(config, {
    async generate() { throw new Error("calculation failed"); },
    publish() { assert.fail("must not publish"); },
  })]);
  const outcome = await runDailyUpdate(config, dailyUpdatePlan([], new Date("2026-09-15T01:00:00Z")), registry, logger, {
    openStore: () => ({
      async sync(options) { return result("completed", options.dataset as "availability" | "dut_utilization"); },
      close() {},
    }),
  });
  assert.equal(outcome.status, "failed");
  assert.equal(outcome.dashboards[0]?.published, false);
  assert.equal(outcome.dashboards[0]?.reason, "calculation failed");
});

test("data commands share storage overrides and environment precedence", (t) => {
  const { directory } = fixture(t);
  writeFileSync(path.join(directory, ".env"), "SQL_WEB_DB_PATH=from-file.sqlite\nSQL_WEB_DEFAULT_DASHBOARD_PATH=custom/default.json\nAPI_USER=test-user\nAPI_PWD=test-pass\n");
  const config = loadDataCommandConfig(directory, { SQL_WEB_DB_PATH: "from-env.sqlite" });
  assert.equal(config.databasePath, path.join(directory, "from-env.sqlite"));
  assert.equal(config.defaultDashboardPath, path.join(directory, "custom/default.json"));
  assert.equal(config.apiUsername, "test-user");
});
