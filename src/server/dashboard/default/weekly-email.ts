import type { DashboardState } from "../../../shared/dashboard.ts";
import type { NotificationEmail } from "../../notifications.ts";
import { dashboardPeriods, weekLabel } from "./periods.ts";
import { createAnalysisTemplate } from "./template.ts";

export const WEEKLY_IMPROVEMENT_NOTIFICATION = "weekly-improvement";

function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;").replaceAll("'", "&#39;").replaceAll("\n", "<br>");
}

export function createWeeklyImprovementEmail(state: DashboardState, throughDate: string): NotificationEmail {
  const template = createAnalysisTemplate("week");
  const card = state.widgets.find((widget) => widget.id === template.id);
  if (!card || card.kind !== "table" || card.warnings.some((warning) => warning.startsWith("本次分析暂不可用"))) {
    throw new Error("本次周改善措施表不可用");
  }
  const period = dashboardPeriods(throughDate).week;
  const title = "周改善措施表（" + weekLabel(period.start) + "）";
  const description = [
    "统计周期：" + period.start + " 至 " + period.end + "（周日至周六）",
    "截止业务日：" + throughDate, card.subtitle,
  ];
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
    subject: title + " · 截止 " + throughDate,
    text: [title, ...description, "", headers.join("\t"),
      ...(rows.length ? rows.map((row) => row.join("\t")) : [emptyMessage]), "", ...notes].join("\n"),
    html: "<h2>" + escapeHtml(title) + "</h2>" + description.map((line) => "<p>" + escapeHtml(line) + "</p>").join("") +
      "<table><thead><tr>" + headers.map((header) => "<th>" + escapeHtml(header) + "</th>").join("") + "</tr></thead><tbody>" +
      (rows.length ? rows.map((row) => "<tr>" + row.map((cell) => "<td>" + escapeHtml(cell) + "</td>").join("") + "</tr>").join("") :
        '<tr><td colspan="6">' + emptyMessage + "</td></tr>") + "</tbody></table>" +
      notes.map((note) => "<p>" + escapeHtml(note) + "</p>").join(""),
  };
}
