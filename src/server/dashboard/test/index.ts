import type { DashboardDefinition } from "../index.ts";
import { projectTestDashboard } from "./calculate/index.ts";

export function createTestDashboardDefinition(source: Pick<DashboardDefinition, "loadInitial">): DashboardDefinition {
  return { id: "test", loadInitial: () => projectTestDashboard(source.loadInitial()) };
}
