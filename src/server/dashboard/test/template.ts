import { parseDashboardState, type DashboardState } from "../../../shared/dashboard.ts";
import { createOverviewTemplate } from "../default/template.ts";

const CARD_TEMPLATES = [
  createOverviewTemplate("MT", true),
  createOverviewTemplate("MT", false),
  createOverviewTemplate("ST", true),
  createOverviewTemplate("ST", false),
];

export function createTestDashboard(now = new Date()): DashboardState {
  return parseDashboardState({ schemaVersion: 1, revision: 0, dataAsOf: now.toISOString(),
    dateRange: { start: null, end: null }, widgets: CARD_TEMPLATES });
}
