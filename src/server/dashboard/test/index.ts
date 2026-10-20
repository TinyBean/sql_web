import type { DashboardDefinition } from "../index.ts";
import { projectTestDashboard } from "./calculate/index.ts";

export function createTestDashboardDefinition(source: Pick<DashboardDefinition, "loadInitial">): DashboardDefinition {
  return {
    id: "test",
    loadInitial: () => projectTestDashboard(source.loadInitial()),
    async update(context) {
      const published = source.loadInitial();
      // The registry updates default first. Match this run, including same-day manual reruns.
      if (published.dateRange.end !== context.throughDate || published.dataAsOf !== context.now.toISOString()) {
        return {
          status: "skipped", published: false, dataAsOf: null,
          reason: "默认看板本次未发布新快照，test 保留原有概览",
        };
      }
      const state = projectTestDashboard(published);
      const warnings = [...new Set([...context.syncWarnings, ...state.widgets.flatMap((widget) => widget.warnings)])];
      // This dashboard is a live projection of the shared publication, with no second snapshot to write.
      context.logger.info("daily.dashboard.published", {
        dashboardId: "test", sourceDashboardId: "default", throughDate: context.throughDate,
        dataAsOf: state.dataAsOf, widgetCount: state.widgets.length,
      });
      return {
        status: warnings.length ? "completed_with_warnings" : "completed",
        published: true, dataAsOf: state.dataAsOf,
        reason: warnings.length ? warnings.join("；") : null,
        details: { sourceDashboardId: "default", widgetCount: state.widgets.length },
      };
    },
  };
}
