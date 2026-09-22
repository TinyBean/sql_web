import { randomUUID } from "node:crypto";
import { PROJECT_ROOT } from "../src/server/config.ts";
import { DailyFileLogger } from "../src/server/logger.ts";
import { createDashboardRegistry } from "../src/server/dashboard/index.ts";
import { loadDataCommandConfig } from "./database/data-command-config.ts";
import { dailyUpdatePlan } from "./database/daily-update.ts";
import { runDailyUpdate } from "./scheduling/daily-update.ts";
import { outcomeExitCode } from "./database/oee-data-store.ts";

async function main(): Promise<void> {
  const now = new Date();
  const plan = dailyUpdatePlan(process.argv.slice(2), now);
  const config = loadDataCommandConfig(PROJECT_ROOT);
  const registry = createDashboardRegistry(config);
  if (plan.dryRun) {
    console.log(JSON.stringify({
      ...plan, databasePath: config.databasePath,
      dashboards: registry.list().map(({ id, update }) => ({ dashboardId: id, hasUpdate: !!update })),
    }, null, 2));
    return;
  }
  const runId = randomUUID();
  const logger = new DailyFileLogger(config.logDir, { filenamePrefix: "oee-daily" })
    .child({ commandRunId: runId });
  const started = Date.now();
  logger.info("daily.started", {
    throughDate: plan.throughDate, requests: plan.requests,
    databasePath: config.databasePath,
  });
  try {
    const result = await runDailyUpdate(config, plan, registry, logger, undefined, runId);
    logger.info("daily.completed", { ...result, durationMs: Date.now() - started });
    console.log(JSON.stringify(result, null, 2));
    process.exitCode = outcomeExitCode(result.status);
  } catch (error) {
    logger.error("daily.failed", error, { throughDate: plan.throughDate });
    throw error;
  }
}

await main().catch((error: unknown) => {
  console.error(JSON.stringify({
    status: "failed", error: error instanceof Error ? error.message : String(error),
  }));
  process.exitCode = 1;
});
