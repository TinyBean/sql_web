import { randomUUID } from "node:crypto";
import type { AppLogger } from "../../src/server/logger.ts";
import type { OeeDataStoreOptions, RunOutcome } from "../database/oee-data-store.ts";
import type { DashboardRegistry, DashboardUpdateContext, DashboardUpdateOutcome } from "../../src/server/dashboard/index.ts";
import { dailyUpdatePlan, syncDailyDatabase, type DailyDatabaseDependencies } from "../database/daily-update.ts";

export interface DashboardRunResult extends DashboardUpdateOutcome {
  readonly dashboardId: string;
}

export async function runDailyUpdate(
  options: OeeDataStoreOptions,
  plan: ReturnType<typeof dailyUpdatePlan>,
  registry: DashboardRegistry,
  logger: AppLogger,
  dependencies?: DailyDatabaseDependencies,
  runId: string = randomUUID(),
) {
  const database = await syncDailyDatabase(options, plan, logger, dependencies);
  const context: DashboardUpdateContext = {
    databasePath: options.databasePath, throughDate: plan.throughDate, now: new Date(),
    syncWarnings: database.warnings, runId, logger,
  };
  const dashboards: DashboardRunResult[] = [];
  for (const definition of registry.list()) {
    const dashboardLogger = logger.child({ dashboardId: definition.id });
    const started = Date.now();
    let result: DashboardRunResult;
    try {
      if (database.status === "failed" || !definition.update) {
        result = {
          dashboardId: definition.id, status: "skipped", published: false, dataAsOf: null,
          reason: database.status === "failed" ? "数据同步失败" : "未注册更新入口",
        };
      } else {
        dashboardLogger.info("daily.dashboard.started", { throughDate: plan.throughDate });
        const outcome = await definition.update({ ...context, logger: dashboardLogger });
        result = { ...outcome, dashboardId: definition.id };
      }
    } catch (error) {
      dashboardLogger.error("daily.dashboard.failed", error, { throughDate: plan.throughDate });
      result = {
        dashboardId: definition.id, status: "failed", published: false, dataAsOf: null,
        reason: error instanceof Error ? error.message : String(error),
      };
    }
    dashboardLogger.info("daily.dashboard.completed", { ...result, durationMs: Date.now() - started });
    dashboards.push(result);
  }
  const statuses = [database.status, ...dashboards.map((result) => result.status)];
  const status: RunOutcome = statuses.includes("failed") ? "failed" :
    statuses.includes("completed_with_warnings") ? "completed_with_warnings" : "completed";
  return {
    status, throughDate: plan.throughDate, database, dashboards,
  };
}
