import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import test, { type TestContext } from "node:test";
import type { DashboardState } from "../../src/shared/dashboard.ts";
import type { AppLogger } from "../../src/server/logger.ts";
import type { DashboardDefinition, DashboardUpdateContext, DashboardUpdateOutcome } from "../../src/server/dashboard/definition.ts";
import { DashboardRegistry } from "../../src/server/dashboard/registry.ts";
import { createDashboardRegistry } from "../../src/server/dashboard/registered.ts";
import { planDashboardUpdates } from "../../src/server/dashboard/update-runner.ts";
import { createDefaultDashboardDefinition } from "../../src/server/dashboard/default/index.ts";
import { readDashboardSnapshot, writeDashboardSnapshot } from "../../src/server/dashboard/snapshot-store.ts";
import { dailyUpdatePlan, type DailyDatabaseDependencies } from "../../scripts/database/daily-update.ts";
import { loadDataCommandConfig } from "../../scripts/database/data-command-config.ts";
import { outcomeExitCode } from "../../scripts/database/oee-data-store.ts";
import { runDailyUpdate } from "../../scripts/scheduling/daily-update.ts";
import { defaultDashboardOutput } from "../../scripts/scheduling/daily-output.ts";

const logger: AppLogger = { info() {}, warn() {}, error() {}, child() { return this; } };
const now = new Date("2026-09-15T01:00:00.000Z");
const plan = dailyUpdatePlan([], now);
const snapshot: DashboardState = { schemaVersion: 1, revision: 0, dataAsOf: now.toISOString(),
  dateRange: { start: null, end: null }, widgets: [] };

function fixture(t: TestContext) {
  const directory = mkdtempSync(path.join(tmpdir(), "dashboard-updates-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return { directory, config: loadDataCommandConfig(directory, {}) };
}

function module(id: string, run?: (context: DashboardUpdateContext) => Promise<DashboardUpdateOutcome>): DashboardDefinition {
  return { id, loadInitial() { assert.fail("scheduled updates must not read session templates"); },
    ...(run ? { update: { plan: () => ({ action: "run", reason: null }), run } } : {}) };
}

function database(calls: string[], warnings = false): DailyDatabaseDependencies {
  return { openStore() {
    calls.push("open");
    return {
      async sync(options) {
        calls.push(options.dataset!);
        return { runId: "sync", status: warnings ? "completed_with_warnings" : "completed", datasets: [] };
      },
      close() { calls.push("close"); },
    };
  } };
}

test("one database sync precedes serial independent publications; planning and publication failures do not stop later boards", async (t) => {
  const { directory, config } = fixture(t);
  const calls: string[] = [];
  const file = (id: string) => path.join(directory, id + ".json");
  writeDashboardSnapshot(file("invalid"), snapshot);
  const original = readFileSync(file("invalid"), "utf8");
  const success = (id: string) => module(id, async (context) => {
    calls.push(id);
    assert.equal(context.databasePath, config.databasePath);
    assert.equal(context.throughDate, plan.throughDate);
    assert.equal(context.runId, "run-test");
    assert.equal(context.syncWarnings.length, 2);
    writeDashboardSnapshot(file(id), snapshot);
    return { status: "completed", published: true, dataAsOf: snapshot.dataAsOf, reason: null };
  });
  const registry = new DashboardRegistry([
    success("first"),
    module("invalid", async () => {
      calls.push("invalid");
      writeDashboardSnapshot(file("invalid"), { ...snapshot, revision: 1 });
      assert.fail("validation should reject publication");
    }),
    { id: "bad-plan", loadInitial: () => snapshot, update: {
      plan() { throw new Error("invalid strategy"); }, async run() { assert.fail("invalid plan must not execute"); },
    } },
    { id: "weekly", loadInitial: () => snapshot, update: {
      plan(context) { assert.equal(context.syncWarnings.length, 2); return { action: "skip", reason: "本周无需更新" }; },
      async run() { assert.fail("skipped strategy must not execute"); },
    } },
    module("static"),
    success("last"),
  ]);
  const result = await runDailyUpdate(config, plan, registry, logger, database(calls, true), "run-test");
  assert.deepEqual(calls, ["open", "availability", "dut_utilization", "close", "first", "invalid", "last"]);
  assert.deepEqual(result.dashboards.map((item) => item.status), ["completed", "failed", "failed", "skipped", "skipped", "completed"]);
  assert.equal(result.database.status, "completed_with_warnings");
  assert.equal(outcomeExitCode(result.status), 1);
  assert.equal(readFileSync(file("invalid"), "utf8"), original);
  assert.deepEqual(readDashboardSnapshot(file("first")), snapshot);
  assert.deepEqual(readDashboardSnapshot(file("last")), snapshot);
  assert.equal(result.dashboards[3]?.reason, "本周无需更新");
});

test("empty registries and static-only registries still update the database and finish successfully", async (t) => {
  const { config } = fixture(t);
  for (const definitions of [[], [module("static")]]) {
    const calls: string[] = [];
    const result = await runDailyUpdate(config, plan, new DashboardRegistry(definitions), logger, database(calls));
    assert.deepEqual(calls, ["open", "availability", "dut_utilization", "close"]);
    assert.equal(outcomeExitCode(result.status), 0);
    assert.ok(result.dashboards.every((item) => item.status === "skipped"));
  }
});

test("database open, sync, reported, and close failures skip every strategy", async (t) => {
  const { config } = fixture(t);
  for (const failure of ["open", "sync", "reported", "close"]) {
    const calls: string[] = [];
    const registry = new DashboardRegistry([{ id: "default", loadInitial: () => snapshot, update: {
      plan() { assert.fail("must not plan after sync failure"); }, async run() { assert.fail("must not update"); },
    } }]);
    const result = await runDailyUpdate(config, plan, registry, logger, {
      openStore() {
        if (failure === "open") throw new Error("open failed");
        return {
          async sync(options) {
            calls.push(options.dataset!);
            if (options.dataset === "availability" && failure === "sync") throw new Error("sync failed");
            return { runId: "test", datasets: [], status: failure === "reported" ? "failed" : "completed" };
          },
          close() { calls.push("close"); if (failure === "close") throw new Error("close failed"); },
        };
      },
    });
    assert.equal(result.status, "failed", failure);
    assert.deepEqual(calls, failure === "open" ? [] : ["availability", "dut_utilization", "close"]);
    assert.equal(result.dashboards[0]?.status, "skipped");
    assert.equal(result.dashboards[0]?.published, false);
    assert.equal(defaultDashboardOutput(result.dashboards).analysisReason, "数据同步失败");
  }
});

test("module warnings and sync warnings yield exit code 2; CLI legacy fields refer only to default", async (t) => {
  const { config } = fixture(t);
  const registry = new DashboardRegistry([
    module("default", async () => ({ status: "completed_with_warnings", published: true, dataAsOf: snapshot.dataAsOf,
      reason: "analysis unavailable", details: { analysisStatus: "timed_out", analysisReason: "analysis unavailable",
        analysisRunId: "analysis-run", analysisArtifactDir: "analysis-dir" } })),
    module("other", async () => ({ status: "completed", published: true, dataAsOf: "2026-09-16T01:00:00.000Z", reason: null })),
  ]);
  const result = await runDailyUpdate(config, plan, registry, logger, database([]));
  assert.equal(outcomeExitCode(result.status), 2);
  assert.deepEqual(defaultDashboardOutput(result.dashboards), { published: true, dataAsOf: snapshot.dataAsOf,
    analysisStatus: "timed_out", analysisReason: "analysis unavailable", analysisRunId: "analysis-run", analysisArtifactDir: "analysis-dir" });
  assert.equal(defaultDashboardOutput(result.dashboards.slice(1)).published, false);
  const warningOnly = await runDailyUpdate(config, plan, new DashboardRegistry([]), logger, database([], true));
  assert.equal(outcomeExitCode(warningOnly.status), 2);
});

test("dry-run plans all registered boards without loading snapshots, updating, or writing artifacts", async (t) => {
  const { config, directory } = fixture(t);
  const defaultDefinition = createDefaultDashboardDefinition(config, {
    async generate() { assert.fail("dry-run must not generate"); }, publish() { assert.fail("dry-run must not publish"); },
  });
  const context = { databasePath: config.databasePath, throughDate: plan.throughDate, now, syncWarnings: [], runId: "dry-run", logger };
  const registry = new DashboardRegistry([defaultDefinition, module("static"), {
    id: "weekly", loadInitial: () => snapshot, update: {
      plan: () => ({ action: "skip", reason: "非更新时间" }), async run() { assert.fail("dry-run must not execute"); },
    },
  }]);
  const plans = planDashboardUpdates(registry, context);
  assert.deepEqual(plans.map((item) => item.action), ["run", "skip", "skip"]);
  assert.ok("outputPath" in plans[0]! && plans[0].outputPath === config.defaultDashboardPath);
  assert.deepEqual(planDashboardUpdates(createDashboardRegistry(config), context), plans.slice(0, 1));
  await assert.rejects(runDailyUpdate(config, { ...plan, dryRun: true }, registry, logger, {
    openStore() { assert.fail("dry-run must not open database"); },
  }), /dry-run/u);
  assert.deepEqual(readdirSync(directory), []);
});

test("daily CLI dry-run reports database requests and per-board plans with legacy fields", (t) => {
  const { directory, config } = fixture(t);
  const compiled = import.meta.url.endsWith(".js");
  const entry = fileURLToPath(new URL(compiled ? "../../scripts/oee-daily.js" : "../../scripts/oee-daily.ts", import.meta.url));
  const result = spawnSync(process.execPath, [...(compiled ? [] : ["--import", "tsx"]), entry,
    "--dry-run", "--through-date", "2026-01-12"], { encoding: "utf8", timeout: 10_000, env: {
    ...process.env, SQL_WEB_DB_PATH: config.databasePath, SQL_WEB_DEFAULT_DASHBOARD_PATH: config.defaultDashboardPath,
  } });
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.dryRun, true);
  assert.equal(output.requests.length, 2);
  assert.equal(output.defaultDashboardPath, config.defaultDashboardPath);
  assert.equal(output.dashboards[0].dashboardId, "default");
  assert.equal(output.dashboards[0].action, "run");
  assert.deepEqual(output.periods, output.dashboards[0].details.periods);
  assert.deepEqual(readdirSync(directory), []);
});
