import { createDefaultDashboardDefinition, type DefaultDashboardOptions } from "./default/index.ts";
import { DashboardRegistry } from "./registry.ts";

/** The shared registration point used by both the web service and the daily command. */
export function createDashboardRegistry(options: DefaultDashboardOptions = {}): DashboardRegistry {
  return new DashboardRegistry([
    createDefaultDashboardDefinition(options),
  ]);
}
