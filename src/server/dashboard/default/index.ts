import type { AppLogger } from "../../logger.ts";
import type { DashboardDefinition } from "../index.ts";
import type { DefaultDashboardAnalysisConfig } from "./config.ts";
import type { generateDefaultDashboard } from "./run.ts";
import { readDefaultDashboard, writeDefaultDashboard } from "./store.ts";

export interface DefaultDashboardOptions {
  readonly defaultDashboardPath?: string;
  readonly analysis?: DefaultDashboardAnalysisConfig;
  readonly logger?: Pick<AppLogger, "info" | "error">;
}

export interface DefaultDashboardDependencies {
  generate: typeof generateDefaultDashboard;
  publish: typeof writeDefaultDashboard;
}

const DEFAULT_DEPENDENCIES: DefaultDashboardDependencies = {
  async generate(...args) {
    const { generateDefaultDashboard } = await import("./run.ts");
    return generateDefaultDashboard(...args);
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
    id: "default",
    loadInitial: () => readDefaultDashboard(defaultDashboardPath, logger),
    ...(analysis && defaultDashboardPath ? {
      async update(context) {
        const { state, ...details } = await dependencies.generate(
          { databasePath: context.databasePath, analysis }, context.throughDate,
          context.now, context.syncWarnings, context.logger, context.runId,
        );
        dependencies.publish(defaultDashboardPath, state);
        const hasWarnings = context.syncWarnings.length > 0 || details.analysisStatus !== "completed" ||
          state.widgets.some((widget) => widget.warnings.some((warning) =>
            warning.includes("缺") || warning.includes("尚未") || warning.includes("仅反映已有数据")));
        context.logger.info("daily.dashboard.published", {
          dashboardId: "default", filePath: defaultDashboardPath,
          throughDate: context.throughDate, dataAsOf: state.dataAsOf, widgetCount: state.widgets.length,
        });
        return {
          status: hasWarnings ? "completed_with_warnings" : "completed",
          published: true, dataAsOf: state.dataAsOf, reason: details.analysisReason, details,
        };
      },
    } : {}),
  };
}
