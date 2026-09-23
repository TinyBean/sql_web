import type { DashboardState } from "../../src/shared/dashboard.ts";
import { dashboardPeriods, weekLabel } from "../../src/server/dashboard/default/periods.ts";
import { createAnalysisTemplate, createDefaultDashboard } from "../../src/server/dashboard/default/template.ts";

export function weeklyDashboard(throughDate = "2026-09-14"): DashboardState {
  const period = dashboardPeriods(throughDate).week;
  const week = createAnalysisTemplate("week");
  const state = createDefaultDashboard(new Date("2026-09-15T01:00:00Z"));
  return { ...state, widgets: state.widgets.map((widget) => widget.id !== week.id ? { ...widget, warnings: [] } : {
    ...week,
    title: week.title + "（" + weekLabel(period.start) + "）",
    subtitle: "最近完整周 · " + period.start + " 至 " + period.end + " · 临时 Agent 分析",
    metricDefinition: period.start + " 至 " + period.end + " 的" + week.metricDefinition,
    warnings: ["责任人列为职能建议，需管理层确认后指派到人"],
    data: [
      { kind: "MT", priority: 1, issue: "换线时间偏长", measure: "复查换线步骤",
        suggested_owner: "生产主管（职能建议，待人工确认）", loss_hours: 2.5 },
      { kind: "ST", priority: 1, issue: "测试时间波动", measure: "验证测试参数",
        suggested_owner: "测试工程（职能建议，待人工确认）", loss_hours: null },
    ],
  }) };
}
