import type { DashboardState } from "../../../shared/dashboard.ts";
import type { AppLogger } from "../../logger.ts";
import { readDashboardSnapshot, writeDashboardSnapshot } from "../snapshot-store.ts";
import { createDefaultDashboard } from "./template.ts";
import { buildTypeOverviews } from "./overviews.ts";

function validateDefault(state: DashboardState): void {
  const expected = createDefaultDashboard().widgets.map((widget) => widget.id);
  if (state.widgets.length !== expected.length ||
      state.widgets.some((widget, index) => widget.id !== expected[index])) {
    throw new Error("默认看板必须包含固定顺序的 10 张卡片");
  }
}

export function readDefaultDashboard(filePath?: string, logger?: Pick<AppLogger, "info" | "error">): DashboardState {
  if (!filePath) return createDefaultDashboard();
  try {
    const snapshot = readDashboardSnapshot(filePath);
    const widgets = [...snapshot.widgets];
    const legacy = widgets[0];
    if (legacy?.id === "overall-oee-overview" && legacy.kind === "overview" &&
        snapshot.dateRange.start && snapshot.dateRange.end) {
      // Old defaults contain per-type OEE but only combined component averages.
      // Preserve the other eight cards; never present combined averages as MT/ST.
      const overviews = buildTypeOverviews([], { start: snapshot.dateRange.start, end: snapshot.dateRange.end })
        .map((overview, index) => {
          const kind = index === 0 ? "MT" : "ST";
          const value = legacy.data[0]?.[kind.toLowerCase() + "_oee_percent"];
          return {
            ...overview,
            data: [{ ...overview.data[0], overall_oee_percent: typeof value === "number" ? value : null }],
            encoding: { ...overview.encoding, description: `沿用旧版快照的 ${kind} 日 OEE 等权平均` },
            warnings: [...legacy.warnings, "旧版快照未保存分类组成项，Availability、Performance、Yield 暂无数据，待每日更新补齐"],
          };
        });
      widgets.splice(0, 1, ...overviews);
    }
    const [quarterly, monthly, weekly] = widgets.slice(2, 5);
    // Keep published data when reading snapshots with the former trend order.
    if (quarterly?.id === "oee-trend-quarterly-2026" &&
        monthly?.id === "oee-trend-monthly-2026" && weekly?.id === "oee-trend-weekly-2026") {
      widgets.splice(2, 3, weekly, monthly, quarterly);
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
