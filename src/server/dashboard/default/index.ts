import type { AppLogger } from "../../logger.ts";
import type { DashboardDefinition } from "../definition.ts";
import { DEFAULT_DASHBOARD_ID } from "../registry.ts";
import type { DefaultDashboardAnalysisConfig } from "./config.ts";
import type { generateAnalyzedDashboard } from "./analysis/run.ts";
import { dashboardPeriods } from "./periods.ts";
import { readDefaultDashboard, writeDefaultDashboard } from "./store.ts";

export interface DefaultDashboardOptions {
  readonly defaultDashboardPath?: string;
  readonly analysis?: DefaultDashboardAnalysisConfig;
  readonly logger?: Pick<AppLogger, "info" | "error">;
}

export interface DefaultDashboardDependencies {
  generate: typeof generateAnalyzedDashboard;
  publish: typeof writeDefaultDashboard;
}

const DEFAULT_DEPENDENCIES: DefaultDashboardDependencies = {
  async generate(...args) {
    const { generateAnalyzedDashboard } = await import("./analysis/run.ts");
    return generateAnalyzedDashboard(...args);
  },
  publish: writeDefaultDashboard,
};

export function createDefaultDashboardDefinition(
  options: DefaultDashboardOptions = {},
  dependencies: DefaultDashboardDependencies = DEFAULT_DEPENDENCIES,
): DashboardDefinition {
  const { defaultDashboardPath, analysis, logger } = options;
  if (analysis && !defaultDashboardPath) throw new Error("默认看板更新需要发布路径");
  return {
    id: DEFAULT_DASHBOARD_ID,
    loadInitial: () => readDefaultDashboard(defaultDashboardPath, logger),
    ...(analysis && defaultDashboardPath ? {
      update: {
        plan(context) {
          const periods = dashboardPeriods(context.throughDate);
          return {
            action: "run", reason: null, outputPath: defaultDashboardPath,
            details: { periods: { ...periods, trend: { ...periods.trend }, week: { ...periods.week },
              month: { ...periods.month }, quarter: { ...periods.quarter } } },
          };
        },
        async run(context) {
          const { state, ...details } = await dependencies.generate(
            { databasePath: context.databasePath, analysis }, context.throughDate,
            context.now, context.syncWarnings, context.logger, context.runId,
          );
          dependencies.publish(defaultDashboardPath, state);
          const hasWarnings = context.syncWarnings.length > 0 || details.analysisStatus !== "completed" ||
            state.widgets.some((widget) => widget.warnings.some((warning) =>
              warning.includes("缺") || warning.includes("尚未") || warning.includes("仅反映已有数据")));
          context.logger.info("daily.dashboard.published", {
            dashboardId: DEFAULT_DASHBOARD_ID, filePath: defaultDashboardPath,
            throughDate: context.throughDate, dataAsOf: state.dataAsOf, widgetCount: state.widgets.length,
          });
          return {
            status: hasWarnings ? "completed_with_warnings" : "completed",
            published: true, dataAsOf: state.dataAsOf, reason: details.analysisReason, details,
          };
        },
      } satisfies NonNullable<DashboardDefinition["update"]>,
    } : {}),
  };
}
