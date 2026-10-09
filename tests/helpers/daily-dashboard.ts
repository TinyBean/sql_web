import type { DashboardState } from "../../src/shared/dashboard.ts";
import { dashboardPeriods } from "../../src/server/dashboard/default/periods.ts";
import { createAnalysisTemplate, createDefaultDashboard } from "../../src/server/dashboard/default/template.ts";

export function dailyDashboard(throughDate = "2026-09-14"): DashboardState {
  const period = dashboardPeriods(throughDate).day;
  const day = createAnalysisTemplate("day");
  const state = createDefaultDashboard(new Date(throughDate + "T15:00:00.000Z"));
  return { ...state, widgets: state.widgets.map((widget) => widget.id !== day.id ? { ...widget, warnings: [] } : {
    ...day,
    title: day.title + "（" + period.end + "）",
    subtitle: "最新业务日 · " + period.end + " · 临时 Agent 分析",
    metricDefinition: period.start + " 至 " + period.end + " 的" + day.metricDefinition,
    warnings: ["责任人列为职能建议，需管理层确认后指派到人"],
    data: [
      { kind: "MT", priority: 1, issue: "换线时间偏长", measure: "复查换线步骤",
        suggested_owner: "生产主管（职能建议，待人工确认）", loss_hours: 2.5 },
      { kind: "ST", priority: 1, issue: "测试等待偏长", measure: "核查等待记录并复测等待时长",
        suggested_owner: "测试工程（职能建议，待人工确认）", loss_hours: 1.2 },
    ],
  }) };
}
