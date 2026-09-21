import type { DashboardState } from "../../../shared/dashboard.ts";
import type { AppLogger } from "../../logger.ts";
import { readDashboardSnapshot, writeDashboardSnapshot } from "../snapshot-store.ts";
import { createDefaultDashboard } from "./template.ts";
import { buildTypeOverviews } from "./overviews.ts";

function validateDefault(state: DashboardState): void {
  const expected = createDefaultDashboard().widgets.map((widget) => widget.id);
  if (state.widgets.length !== expected.length ||
      state.widgets.some((widget, index) => widget.id !== expected[index])) {
    throw new Error("默认看板必须包含固定顺序的 12 张卡片");
  }
}

export function readDefaultDashboard(filePath?: string, logger?: Pick<AppLogger, "info" | "error">): DashboardState {
  if (!filePath) return createDefaultDashboard();
  try {
    const snapshot = readDashboardSnapshot(filePath);
    if (snapshot.widgets.length === 12) {
      validateDefault(snapshot);
      return snapshot;
    }
    const oldPerformance = snapshot.widgets.some((widget) => widget.kind === "overview" &&
      !Object.hasOwn(widget.data[0] ?? {}, "avg_test_time_percent"));
    const widgets = [...snapshot.widgets];
    const legacy = widgets[0];
    if (legacy?.id === "overall-oee-overview" && legacy.kind === "overview" &&
        snapshot.dateRange.start && snapshot.dateRange.end) {
      // Old defaults contain per-type OEE but only combined component averages.
      // Preserve the other eight cards; never present combined averages as MT/ST.
      const overviews = buildTypeOverviews([], { start: snapshot.dateRange.start, end: snapshot.dateRange.end })
        .filter((overview) => overview.encoding.label === "Test OEE")
        .map((overview, index) => {
          const kind = index === 0 ? "MT" : "ST";
          const value = legacy.data[0]?.[kind.toLowerCase() + "_oee_percent"];
          return {
            ...overview,
            data: [{ ...overview.data[0], overall_oee_percent: typeof value === "number" ? value : null }],
            encoding: { ...overview.encoding, description: `沿用旧版快照的 ${kind} 日 OEE 等权平均` },
            warnings: [...legacy.warnings, "旧版快照未保存分类组成项，Availability、Performance (DUT-On)、Performance (Test Time)、Yield 暂无数据，待每日更新补齐"],
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
    if (oldPerformance) {
      const warning = "旧口径快照：OEE 未包含 Performance (Test Time)，需重新计算；Test Time 无法从旧 OEE 反推";
      for (const [index, widget] of widgets.entries()) {
        const updated = {
          ...widget,
          metricDefinition: "旧口径 OEE = Availability×Performance (DUT-On)×Yield；本快照未重算。" +
            (widget.kind === "overview" ? "保留历史 OEE 和已知组成项，Test Time 暂无数据。" : widget.metricDefinition),
          warnings: [...widget.warnings, warning],
        };
        widgets[index] = updated.kind === "overview" ? {
          ...updated,
          data: updated.data.map((row) => ({ ...row,
            avg_dut_on_percent: row["avg_dut_on_percent"] ?? row["avg_performance_percent"] ?? null,
            avg_test_time_percent: null,
          })),
          encoding: { ...updated.encoding, gauges: [
            { name: "Availability", column: "avg_availability_percent" },
            { name: "Performance (DUT-On)", column: "avg_dut_on_percent" },
            { name: "Performance (Test Time)", column: "avg_test_time_percent" },
            { name: "Yield", column: "avg_yield_percent" },
          ] },
        } : updated;
      }
    }
    if (widgets[0]?.id === "mt-oee-overview" && widgets[1]?.id === "st-oee-overview" &&
        snapshot.dateRange.start && snapshot.dateRange.end) {
      const range = { start: snapshot.dateRange.start, end: snapshot.dateRange.end };
      const effective = buildTypeOverviews([], range)
        .filter((overview) => overview.encoding.label === "Effective OEE")
        .map((overview) => ({ ...overview,
          encoding: { ...overview.encoding, description: "旧版快照未保存 Effective OEE，待每日更新补齐" },
          warnings: ["旧版快照未保存 Effective OEE 及其组成项，暂无数据，待每日更新补齐"],
        }));
      const tests = widgets.slice(0, 2).map((widget, index) => {
        if (widget.kind !== "overview") throw new Error("默认看板概览类型无效");
        return { ...widget, size: "medium" as const, title: `${index === 0 ? "MT" : "ST"} · Test OEE`,
          encoding: { ...widget.encoding, label: "Test OEE" } };
      });
      widgets.splice(0, 2, effective[0]!, tests[0]!, effective[1]!, tests[1]!);
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
