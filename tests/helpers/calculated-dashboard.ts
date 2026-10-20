import { DatabaseSync } from "node:sqlite";
import { calculateDefaultDashboard } from "../../src/server/dashboard/default/calculate/index.ts";

/** Build evidence-test fixtures without starting an Agent or publishing a snapshot. */
export function calculatedDashboard(
  database: DatabaseSync, throughDate: string, now = new Date(), warnings: readonly string[] = [],
) {
  return calculateDefaultDashboard(database, throughDate, now, warnings);
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
