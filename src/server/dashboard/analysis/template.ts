import { parseDashboardState, type DashboardState } from "../../../shared/dashboard.ts";
import { createAnalysisTemplate, createMachineAnalysisTemplates } from "../default/template.ts";
import { ANALYSIS_PERIOD_KEYS } from "../default/calculate/periods.ts";

const CARD_TEMPLATES = [...ANALYSIS_PERIOD_KEYS.map(createAnalysisTemplate), ...createMachineAnalysisTemplates()];

export function createAnalysisDashboard(now = new Date()): DashboardState {
  return parseDashboardState({ schemaVersion: 1, revision: 0, dataAsOf: now.toISOString(),
    dateRange: { start: null, end: null }, widgets: CARD_TEMPLATES });
}
