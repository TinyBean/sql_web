import { randomUUID } from "node:crypto";
import { PROJECT_ROOT } from "../src/server/config.ts";
import { DailyFileLogger, type AppLogger } from "../src/server/logger.ts";
import { createDashboardRegistry } from "../src/server/dashboard/registered.ts";
import { DEFAULT_DASHBOARD_ID } from "../src/server/dashboard/registry.ts";
import { planDashboardUpdates } from "../src/server/dashboard/update-runner.ts";
import { loadDataCommandConfig } from "./database/data-command-config.ts";
import { dailyUpdatePlan } from "./database/daily-update.ts";
import { runDailyUpdate } from "./scheduling/daily-update.ts";
import { defaultDashboardOutput } from "./scheduling/daily-output.ts";
import { outcomeExitCode } from "./database/oee-data-store.ts";

async function main(): Promise<void> {
  const now = new Date();
  const plan = dailyUpdatePlan(process.argv.slice(2), now);
  const config = loadDataCommandConfig(PROJECT_ROOT);
  const registry = createDashboardRegistry(config);
  if (plan.dryRun) {
    const logger: AppLogger = { info() {}, warn() {}, error() {}, child() { return this; } };
    const dashboards = planDashboardUpdates(registry, {
      databasePath: config.databasePath, throughDate: plan.throughDate, now,
      syncWarnings: [], runId: "dry-run", logger,
    });
    const defaultPlan = dashboards.find((item) => item.dashboardId === DEFAULT_DASHBOARD_ID);
    console.log(JSON.stringify({
      ...plan, databasePath: config.databasePath, defaultDashboardPath: config.defaultDashboardPath,
      periods: defaultPlan && "details" in defaultPlan ? defaultPlan.details?.["periods"] : undefined,
      dashboards,
    }, null, 2));
    process.exitCode = dashboards.some((item) => item.action === "failed") ? 1 : 0;
    return;
  }
  const runId = randomUUID();
  const logger = new DailyFileLogger(config.logDir, { filenamePrefix: "oee-daily" })
    .child({ commandRunId: runId });
  const started = Date.now();
  logger.info("daily.started", {
    throughDate: plan.throughDate, requests: plan.requests,
    databasePath: config.databasePath, defaultDashboardPath: config.defaultDashboardPath,
  });
  try {
    const result = await runDailyUpdate(config, plan, registry, logger, undefined, runId);
    const output = { ...result, ...defaultDashboardOutput(result.dashboards) };
    logger.info("daily.completed", { ...output, durationMs: Date.now() - started });
    console.log(JSON.stringify(output, null, 2));
    process.exitCode = outcomeExitCode(result.status);
  } catch (error) {
    logger.error("daily.failed", error, { throughDate: plan.throughDate, published: false });
    throw error;
  }
}

await main().catch((error: unknown) => {
  console.error(JSON.stringify({
    status: "failed", published: false, error: error instanceof Error ? error.message : String(error),
  }));
  process.exitCode = 1;
});
