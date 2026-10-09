import type { DashboardState } from "../../../shared/dashboard.ts";
import type { NotificationEmail } from "../../notifications.ts";
import { dashboardPeriods } from "./periods.ts";
import { analysisExclusionSummary, type AnalysisPublication } from "./analysis/report.ts";
import { createAnalysisTemplate } from "./template.ts";

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
    ["issue", "measure", "suggested_owner"].some((key) => typeof row[key] !== "string" || !String(row[key]).trim()))) {
    throw new Error("日改善措施表的问题、改善措施、责任职能和本期损失小时均为必填");
  }
  const period = dashboardPeriods(throughDate).day;
  const title = "日改善措施表（" + period.end + "）";
  const description = [
    "统计业务日：" + period.end,
    "截止业务日：" + throughDate, card.subtitle,
  ];
  if (quality?.status === "degraded") description.push(analysisExclusionSummary(quality.exclusions), "仅展示已通过证据校验的日建议。其他周期的建议请查看看板。 ");
  const columns = template.encoding.columns;
  const headers = columns.map((column) => column.label);
  const rows = card.data.map((row) => columns.map(({ key }) => {
    const value = row[key];
    return value === null || value === undefined ? "—" :
      key === "loss_hours" && typeof value === "number" ? value.toFixed(card.format.precision) : String(value);
  }));
  const emptyMessage = "本期未生成改善建议，原因见下方提示。";
  const notes = ["统计口径：" + card.metricDefinition, ...card.warnings.map((warning) => "提示：" + warning)];
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
