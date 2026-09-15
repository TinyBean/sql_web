import type { DashboardState } from "../../../shared/dashboard.ts";
import type { AppLogger } from "../../logger.ts";
import { readDashboardSnapshot, writeDashboardSnapshot } from "../snapshot-store.ts";
import { createDefaultDashboard } from "./template.ts";

function validateDefault(state: DashboardState): void {
  const expected = createDefaultDashboard().widgets.map((widget) => widget.id);
  if (state.widgets.length !== expected.length ||
      state.widgets.some((widget, index) => widget.id !== expected[index])) {
    throw new Error("默认看板必须包含固定顺序的 9 张卡片");
  }
}

export function readDefaultDashboard(filePath?: string, logger?: Pick<AppLogger, "info" | "error">): DashboardState {
  if (!filePath) return createDefaultDashboard();
  try {
    const snapshot = readDashboardSnapshot(filePath);
    const widgets = [...snapshot.widgets];
    const [quarterly, monthly, weekly] = widgets.slice(1, 4);
    // Keep published data when reading snapshots with the former trend order.
    if (quarterly?.id === "oee-trend-quarterly-2026" &&
        monthly?.id === "oee-trend-monthly-2026" && weekly?.id === "oee-trend-weekly-2026") {
      widgets.splice(1, 3, weekly, monthly, quarterly);
    }
    const state = { ...snapshot, widgets };
    validateDefault(state);
    return state;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      logger?.info("dashboard.default.fallback", { reason: "missing", filePath });
    } else {
      logger?.error("dashboard.default.invalid", error, { filePath });
    }
    return createDefaultDashboard();
  }
}

export function writeDefaultDashboard(filePath: string, state: DashboardState): void {
  writeDashboardSnapshot(filePath, state, validateDefault);
}
