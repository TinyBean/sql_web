import type { DashboardState } from "../../../shared/dashboard.ts";
import type { AppLogger } from "../../logger.ts";
import { readDashboardSnapshot, writeDashboardSnapshot } from "../snapshot-store.ts";
import { createDefaultDashboard, DEFAULT_CARD_IDS } from "./template.ts";

function validateDefault(state: DashboardState): void {
  const expected = DEFAULT_CARD_IDS;
  if (state.widgets.length !== expected.length ||
      state.widgets.some((widget, index) => widget.id !== expected[index])) {
    throw new Error("默认看板必须包含固定顺序的 12 张卡片");
  }
}

export function readDefaultDashboard(filePath?: string, logger?: Pick<AppLogger, "info" | "error">): DashboardState {
  if (!filePath) return createDefaultDashboard();
  try {
    return readDashboardSnapshot(filePath, validateDefault);
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
