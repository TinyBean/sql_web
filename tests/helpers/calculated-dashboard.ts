import { DatabaseSync } from "node:sqlite";
import { parseDashboardState } from "../../src/shared/dashboard.ts";
import { createDefaultDashboard } from "../../src/server/dashboard/default/template.ts";
import { calculateNumericCards } from "../../src/server/dashboard/default/calculate.ts";
import { prepareAnalysisCards } from "../../src/server/dashboard/default/analysis/index.ts";
import { dashboardPeriods } from "../../src/server/dashboard/default/periods.ts";

/** Build evidence-test fixtures without starting an Agent or publishing a snapshot. */
export function calculatedDashboard(
  database: DatabaseSync, throughDate: string, now = new Date(), warnings: readonly string[] = [],
) {
  return parseDashboardState({ ...createDefaultDashboard(now), dateRange: dashboardPeriods(throughDate).trend,
    widgets: [...calculateNumericCards(database, throughDate, warnings), ...prepareAnalysisCards(database, throughDate, warnings)] });
}

export function readCalculatedDashboard(
  databasePath: string, throughDate: string, now = new Date(), warnings: readonly string[] = [],
) {
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    database.exec("BEGIN");
    return calculatedDashboard(database, throughDate, now, warnings);
  } finally { database.close(); }
}
