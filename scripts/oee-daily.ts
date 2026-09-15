import { randomUUID } from "node:crypto";
import { PROJECT_ROOT } from "../src/server/config.ts";
import { DailyFileLogger } from "../src/server/logger.ts";
import { loadDataCommandConfig } from "./database/data-command-config.ts";
import { dailyUpdatePlan, runDailyUpdate } from "./database/daily-update.ts";
import { outcomeExitCode } from "./database/oee-data-store.ts";

async function main(): Promise<void> {
  const plan = dailyUpdatePlan(process.argv.slice(2));
  const config = loadDataCommandConfig(PROJECT_ROOT);
  if (plan.dryRun) {
    console.log(JSON.stringify({
      ...plan, databasePath: config.databasePath, defaultDashboardPath: config.defaultDashboardPath,
    }, null, 2));
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
    const result = await runDailyUpdate(config, plan, logger, undefined, runId);
    logger.info("daily.completed", { ...result, durationMs: Date.now() - started });
    console.log(JSON.stringify(result, null, 2));
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
