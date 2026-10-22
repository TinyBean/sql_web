import type { DashboardState } from "../../../shared/dashboard.ts";
import { formatDisplayNumber } from "../../../shared/number-format.ts";
import type { AppLogger } from "../../logger.ts";
import type { DashboardDefinition } from "../index.ts";
import { readDashboardSnapshot, writeDashboardSnapshot } from "../snapshot-store.ts";
import { skippedNotification, type NotificationDispatcher, type NotificationResult, type NotificationEmail } from "../email.ts";
import { createDefaultDashboard, validateDefaultDashboard, createAnalysisTemplate } from "./template.ts";
import { dashboardPeriods } from "./calculate/periods.ts";
import type { DefaultDashboardAnalysisConfig, generateDefaultDashboard } from "./analysis/index.ts";
import { analysisExclusionSummary, type AnalysisPublication } from "./analysis/validation.ts";

export function readDefaultDashboard(filePath?: string, logger?: Pick<AppLogger, "info" | "error">): DashboardState {
  if (!filePath) return createDefaultDashboard();
  try {
    return readDashboardSnapshot(filePath, validateDefaultDashboard);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      logger?.info("dashboard.default.fallback", { reason: "missing", filePath });
    } else {
      logger?.error("dashboard.default.invalid", error, { filePath });
    }
    return createDefaultDashboard();
  }
}

export function writeDefaultDashboard(filePath: string, state: DashboardState): void {
  writeDashboardSnapshot(filePath, state, validateDefaultDashboard);
}

export const DAILY_IMPROVEMENT_NOTIFICATION = "daily-improvement";

function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;").replaceAll("'", "&#39;").replaceAll("\n", "<br>");
}

export function createDailyImprovementEmail(state: DashboardState, throughDate: string, quality?: AnalysisPublication): NotificationEmail {
  const template = createAnalysisTemplate("day");
  const card = state.widgets.find((widget) => widget.id === template.id);
  if (!card || card.kind !== "table" || card.warnings.some((warning) => warning.startsWith("本次分析暂不可用"))) {
    throw new Error("本次日改善措施表不可用");
  }
  if (card.data.some((row) => typeof row["loss_hours"] !== "number" || !Number.isFinite(row["loss_hours"]) ||
    ["issue", "measure", "suggested_owner"].some((key) => typeof row[key] !== "string"))) {
    throw new Error("日改善措施表正文必须为字符串,本期损失小时必须为有限数值");
  }
  const period = dashboardPeriods(throughDate).day;
  const title = "日改善措施表(" + period.end + ")";
  const description = [
    "统计业务日:" + period.end,
    "截止业务日:" + throughDate, card.subtitle,
  ];
  if (quality?.status === "degraded") description.push(analysisExclusionSummary(quality.exclusions), "仅展示已通过证据校验的日建议。其他周期的建议请查看看板。 ");
  const columns = template.encoding.columns;
  const headers = columns.map((column) => column.label);
  const rows = card.data.map((row) => columns.map(({ key }) => {
    const value = row[key];
    return value === null || value === undefined ? "—" :
      typeof value === "number" ? formatDisplayNumber(value) : String(value);
  }));
  const emptyMessage = "本期未生成改善建议,原因见下方提示。";
  const notes = ["统计口径:" + card.metricDefinition, ...card.warnings.map((warning) => "提示:" + warning)];
  return {
    subject: (quality?.status === "degraded" ? "【报告降级】" : "") + title + " · 截止 " + throughDate,
    text: [title, ...description, "", headers.join("\t"),
      ...(rows.length ? rows.map((row) => row.join("\t")) : [emptyMessage]), "", ...notes].join("\n"),
    html: "<h2>" + escapeHtml(title) + "</h2>" + description.map((line) => "<p>" + escapeHtml(line) + "</p>").join("") +
      "<table><thead><tr>" + headers.map((header) => "<th>" + escapeHtml(header) + "</th>").join("") + "</tr></thead><tbody>" +
      (rows.length ? rows.map((row) => "<tr>" + row.map((cell) => "<td>" + escapeHtml(cell) + "</td>").join("") + "</tr>").join("") :
        '<tr><td colspan="6">' + emptyMessage + "</td></tr>") + "</tbody></table>" +
      notes.map((note) => "<p>" + escapeHtml(note) + "</p>").join(""),
  };
}

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
    const { generateDefaultDashboard } = await import("./analysis/index.ts");
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
    title: "OEE综合看板",
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
          if (["completed", "degraded"].includes(details.analysisStatus)) {
            try {
              notification = await notify({
                messageType: DAILY_IMPROVEMENT_NOTIFICATION,
                buildEmail: () => createDailyImprovementEmail(state, context.throughDate, {
                  status: details.analysisStatus === "degraded" ? "degraded" : "completed", exclusions: details.analysisExclusions ?? [],
                }),
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
