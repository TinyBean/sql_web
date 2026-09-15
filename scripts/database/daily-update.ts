import { type DashboardState } from "../../src/shared/dashboard.ts";
import type { AppLogger } from "../../src/server/logger.ts";
import { addDays, dashboardPeriods, latestClosedBusinessDate } from "../../src/server/tool/dashboard-periods.ts";
import { writeDefaultDashboard } from "../../src/server/tool/default-dashboard-store.ts";
import { generateAnalyzedDashboard, type DailyAnalysisResult } from "../analysis/run.ts";
import type { DataCommandConfig } from "./data-command-config.ts";
import { OeeDataStore, type OeeDataStoreOptions, type SyncOptions, type SyncResult, type RunOutcome } from "./oee-data-store.ts";

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
  const periods = dashboardPeriods(throughDate);
  if (throughDate > latestClosedBusinessDate(now)) throw new Error("截止日期不能晚于最近已结束的业务日");
  return {
    dryRun, throughDate, timezone: "Asia/Shanghai", periods,
    requests: [
      { dataset: "availability", initialStartDate: periods.syncStart, throughDate, overlapDays: 2 },
      {
        dataset: "dut_utilization",
        initialStartDate: addDays(periods.syncStart, 1), throughDate: addDays(throughDate, 1), overlapDays: 2,
      },
    ] as const,
  };
}

interface DailyUpdateDependencies {
  openStore(options: OeeDataStoreOptions): Pick<OeeDataStore, "sync" | "close">;
  generate(config: DataCommandConfig, throughDate: string, now: Date, warnings: readonly string[], logger: AppLogger, runId?: string): Promise<DailyAnalysisResult>;
  publish(filePath: string, state: DashboardState): void;
}

const DEFAULT_DEPENDENCIES: DailyUpdateDependencies = {
  openStore: (options) => OeeDataStore.open(options),
  generate: generateAnalyzedDashboard,
  publish: writeDefaultDashboard,
};

export async function runDailyUpdate(
  config: DataCommandConfig,
  plan: ReturnType<typeof dailyUpdatePlan>,
  logger: AppLogger,
  dependencies: DailyUpdateDependencies = DEFAULT_DEPENDENCIES,
  runId?: string,
): Promise<{ status: RunOutcome; throughDate: string; published: boolean; dataAsOf: string | null;
  analysisStatus: DailyAnalysisResult["analysisStatus"] | "skipped"; analysisReason: string | null;
  analysisRunId?: string; analysisArtifactDir?: string }> {
  if (plan.dryRun) throw new Error("dry-run 不能执行数据库更新");
  const store = dependencies.openStore({ ...config, logger });
  const results: SyncResult[] = [];
  let failed = false;
  try {
    for (const request of plan.requests) {
      try {
        const result = await store.sync(request satisfies SyncOptions);
        results.push(result);
        failed ||= result.status === "failed";
        logger.info("daily.dataset.completed", { dataset: request.dataset, ...result });
      } catch (error) {
        failed = true;
        logger.error("daily.dataset.failed", error, { dataset: request.dataset });
      }
    }
  } finally {
    store.close();
  }
  if (failed) {
    return { status: "failed", throughDate: plan.throughDate, published: false, dataAsOf: null,
      analysisStatus: "skipped", analysisReason: "数据同步失败" };
  }
  const warnings = results.filter((result) => result.status === "completed_with_warnings").map((result) =>
    result.datasets.map((dataset) => dataset.dataset).join("、") +
    " 同步存在缺日、越界或无日期记录；本看板使用已有有效数据，详情见数据同步审计日志",
  );
  const { state, ...analysis } = await dependencies.generate(config, plan.throughDate, new Date(), warnings, logger, runId);
  dependencies.publish(config.defaultDashboardPath, state);
  const status = state.widgets.some((widget) => widget.warnings.some((warning) =>
    warning.includes("缺") || warning.includes("尚未") || warning.includes("仅反映已有数据"),
  )) || warnings.length || analysis.analysisStatus !== "completed" ? "completed_with_warnings" : "completed";
  logger.info("daily.dashboard.published", {
    filePath: config.defaultDashboardPath, throughDate: plan.throughDate,
    dataAsOf: state.dataAsOf, widgetCount: state.widgets.length,
  });
  return { status, throughDate: plan.throughDate, published: true, dataAsOf: state.dataAsOf, ...analysis };
}
