import type { AppLogger } from "../../src/server/logger.ts";
import { addDays, assertDate, latestClosedBusinessDate, latestCompleteWeek } from "../../src/server/database/business-dates.ts";
import { OeeDataStore, type OeeDataStoreOptions, type SyncResult, type RunOutcome } from "./oee-data-store.ts";

export function dailyUpdatePlan(args: readonly string[], now = new Date()) {
  let throughDate = latestClosedBusinessDate(now);
  let explicitDate = false;
  let dryRun = false;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--dry-run" && !dryRun) dryRun = true;
    else if (argument === "--through-date" && !explicitDate && args[index + 1]) {
      throughDate = args[++index]!;
      explicitDate = true;
    } else throw new Error("用法：npm run data:daily -- [--through-date YYYY-MM-DD] [--dry-run]");
  }
  assertDate(throughDate);
  const yearStart = throughDate.slice(0, 4) + "-01-01";
  const weekStart = latestCompleteWeek(throughDate).start;
  const syncStart = weekStart < yearStart ? weekStart : yearStart;
  if (throughDate > latestClosedBusinessDate(now)) throw new Error("截止日期不能晚于最近已结束的业务日");
  return {
    dryRun, throughDate, timezone: "Asia/Shanghai", syncStart,
    requests: [
      { dataset: "availability", initialStartDate: syncStart, throughDate, overlapDays: 2 },
      {
        dataset: "dut_utilization",
        initialStartDate: addDays(syncStart, 1), throughDate: addDays(throughDate, 1), overlapDays: 2,
      },
    ] as const,
  };
}

export interface DailyDatabaseDependencies {
  openStore(options: OeeDataStoreOptions): Pick<OeeDataStore, "sync" | "close">;
}

export interface DailyDatabaseResult {
  readonly status: RunOutcome;
  readonly warnings: readonly string[];
  readonly error: string | null;
  readonly datasets: readonly {
    readonly dataset: "availability" | "dut_utilization";
    readonly status: RunOutcome;
    readonly result?: SyncResult;
    readonly error?: string;
  }[];
}

export async function syncDailyDatabase(
  options: OeeDataStoreOptions,
  plan: ReturnType<typeof dailyUpdatePlan>,
  logger: AppLogger,
  dependencies: DailyDatabaseDependencies = { openStore: (config) => OeeDataStore.open(config) },
): Promise<DailyDatabaseResult> {
  if (plan.dryRun) throw new Error("dry-run 不能执行数据库更新");
  const datasets: Array<DailyDatabaseResult["datasets"][number]> = [];
  const warnings: string[] = [];
  let store: ReturnType<DailyDatabaseDependencies["openStore"]> | undefined;
  let failure: string | null = null;
  try {
    store = dependencies.openStore({ ...options, logger });
    for (const request of plan.requests) {
      try {
        const result = await store.sync(request);
        datasets.push({ dataset: request.dataset, status: result.status, result });
        if (result.status === "completed_with_warnings") {
          warnings.push(request.dataset + " 同步存在缺日、越界或无日期记录；详情见数据同步审计日志");
        }
        logger.info("daily.dataset.completed", { dataset: request.dataset, ...result });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        datasets.push({ dataset: request.dataset, status: "failed", error: message });
        logger.error("daily.dataset.failed", error, { dataset: request.dataset });
      }
    }
  } catch (error) {
    failure = error instanceof Error ? error.message : String(error);
    logger.error("daily.database.failed", error);
  } finally {
    try { store?.close(); } catch (error) {
      failure = error instanceof Error ? error.message : String(error);
      logger.error("daily.database.close_failed", error);
    }
  }
  const status = failure !== null || datasets.some((dataset) => dataset.status === "failed") ? "failed" :
    warnings.length ? "completed_with_warnings" : "completed";
  return { status, warnings, datasets, error: failure };
}
