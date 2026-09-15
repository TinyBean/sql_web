import { randomUUID } from "node:crypto";
import type { AppLogger } from "../../src/server/logger.ts";
import type { OeeDataStoreOptions } from "../database/oee-data-store.ts";
import type { DashboardRegistry } from "../../src/server/dashboard/registry.ts";
import { runDashboardUpdates, summarizeUpdateStatuses } from "../../src/server/dashboard/update-runner.ts";
import { dailyUpdatePlan, syncDailyDatabase, type DailyDatabaseDependencies } from "../database/daily-update.ts";

export async function runDailyUpdate(
  options: OeeDataStoreOptions,
  plan: ReturnType<typeof dailyUpdatePlan>,
  registry: DashboardRegistry,
  logger: AppLogger,
  dependencies?: DailyDatabaseDependencies,
  runId: string = randomUUID(),
) {
  const database = await syncDailyDatabase(options, plan, logger, dependencies);
  const dashboards = await runDashboardUpdates(registry, {
    databasePath: options.databasePath, throughDate: plan.throughDate, now: new Date(),
    syncWarnings: database.warnings, runId, logger,
  }, database.status === "failed" ? "数据同步失败" : undefined);
  return {
    status: summarizeUpdateStatuses([database.status, ...dashboards.map((result) => result.status)]),
    throughDate: plan.throughDate, database, dashboards,
  };
}
