import type { AppLogger } from "../../logger.ts";
import type { DashboardDefinition } from "../index.ts";
import type { DefaultDashboardAnalysisConfig } from "./config.ts";
import type { generateDefaultDashboard } from "./run.ts";
import { readDefaultDashboard, writeDefaultDashboard } from "./store.ts";
import { skippedNotification, type NotificationDispatcher, type NotificationResult } from "../../notifications.ts";
import { createWeeklyImprovementEmail, WEEKLY_IMPROVEMENT_NOTIFICATION } from "./weekly-email.ts";

export interface DefaultDashboardOptions {
  readonly defaultDashboardPath?: string;
  readonly analysis?: DefaultDashboardAnalysisConfig;
  readonly logger?: Pick<AppLogger, "info" | "error">;
  readonly notify?: NotificationDispatcher;
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
  const { defaultDashboardPath, analysis, logger, notify } = options;
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
        context.logger.info("daily.dashboard.published", {
          dashboardId: "default", filePath: defaultDashboardPath,
          throughDate: context.throughDate, dataAsOf: state.dataAsOf, widgetCount: state.widgets.length,
        });
        let notification: NotificationResult | undefined;
        if (notify) {
          notification = skippedNotification("每日分析未成功完成");
          if (details.analysisStatus === "completed") {
            try {
              notification = await notify({
                messageType: WEEKLY_IMPROVEMENT_NOTIFICATION,
                buildEmail: () => createWeeklyImprovementEmail(state, context.throughDate),
              }, context);
            } catch {
              // A notification failure must never turn a successful publication into published:false.
              notification = { ...skippedNotification("通知执行异常，发送结果无法确定，未自动重试"),
                status: "unknown", errorCode: "ENOTIFICATION" };
              context.logger.warn("daily.notification.completed", { ...notification, runId: context.runId });
            }
          }
        }
        const notificationReason = notification && notification.status !== "accepted" && notification.status !== "skipped"
          ? notification.reason : null;
        const hasWarnings = context.syncWarnings.length > 0 || details.analysisStatus !== "completed" || notificationReason !== null ||
          state.widgets.some((widget) => widget.warnings.some((warning) =>
            warning.includes("缺") || warning.includes("尚未") || warning.includes("仅反映已有数据")));
        return {
          status: hasWarnings ? "completed_with_warnings" : "completed",
          published: true, dataAsOf: state.dataAsOf,
          reason: details.analysisReason ?? notificationReason,
          details: { ...details, ...(notification ? { notification } : {}) },
        };
      },
    } : {}),
  };
}
