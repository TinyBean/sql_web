import { parseDashboardState, type DashboardState } from "../../../../shared/dashboard.ts";
import { createAnalysisDashboard } from "../template.ts";
import { fillCardTemplate } from "../../default/template.ts";

/** Reuse published values by ID; the analysis template owns the selection and order. */
export function projectAnalysisDashboard(source: DashboardState): DashboardState {
  const template = createAnalysisDashboard(new Date(source.dataAsOf));
  const cards = new Map(source.widgets.map((widget) => [widget.id, widget]));
  return parseDashboardState({ ...template, dataAsOf: source.dataAsOf, dateRange: source.dateRange,
    widgets: template.widgets.map((widget) => {
      const card = cards.get(widget.id);
      if (!card || card.kind !== widget.kind) throw new Error("默认快照缺少 analysis 看板所需卡片：" + widget.id);
      return fillCardTemplate(widget, card);
    }),
  });
}
