import {
  parseDashboardState, type DashboardState, type DashboardOverviewWidget,
  type DashboardLineWidget, type DashboardTableWidget,
} from "../../../shared/dashboard.ts";
import { PERIOD_KEYS, PERIOD_GRAINS, type PeriodKey } from "./periods.ts";

const WAITING = "尚未更新，等待每日任务生成数据";
const empty = () => ({ subtitle: WAITING, data: [], warnings: [WAITING] });

export function createOverviewTemplate(kind: "MT" | "ST", effective: boolean): DashboardOverviewWidget {
  const label = effective ? "Effective OEE" : "Test OEE";
  const value = effective ? "overall_effective_oee_percent" : "overall_oee_percent";
  const prefix = effective ? "avg_effective_" : "avg_";
  const availability = effective ? "Effective Availability" : "Availability";
  const gauges = [
    { name: availability, column: prefix + "availability_percent" },
    { name: "Performance (DUT-On)", column: prefix + "dut_on_percent" },
    { name: "Performance (Test Time)", column: prefix + "test_time_percent" },
    { name: "Yield", column: prefix + "yield_percent" },
  ];
  return {
    ...empty(), id: kind.toLowerCase() + (effective ? "-effective-oee-overview" : "-oee-overview"),
    kind: "overview", size: "medium", title: kind + " · " + label,
    data: [{ [value]: null, ...Object.fromEntries(gauges.map((gauge) => [gauge.column, null])),
      ...(!effective ? { avg_performance_percent: null } : {}) }],
    encoding: { value, label, description: WAITING, gauges },
    format: { unit: "%", precision: 2 },
    metricDefinition: `${kind} ${label} = AVG(${kind} 日 ${label})×100；日 ${label} = ${availability}×Performance (DUT-On)×Performance (Test Time)×Yield。` +
      (effective ? "Effective Availability = Availability + Idle / (1 + (1 - Idle - Availability))。" : "") +
      `五项指标分别对该类型 ${label} 可计算日等权平均；OEE 不由组成项的平均值再次相乘。沿用有效 LOT、PCIe 排除及 MT/ST 分类规则，缺失或零分母保持 NULL。`,
  };
}

export function createTrendTemplate(key: PeriodKey): DashboardLineWidget {
  const grain = PERIOD_GRAINS[key];
  const name = { week: "weekly", month: "monthly", quarter: "quarterly" }[key];
  return {
    ...empty(), id: "oee-trend-" + name + "-2026", kind: "line", size: "wide", title: "OEE " + grain + "趋势",
    encoding: { category: "period_label", series: [
      { name: grain + " OEE", column: "oee_percent" },
      { name: "最高点", column: "max_point" }, { name: "最低点", column: "min_point" },
    ] },
    format: { unit: "%", precision: 2 },
    metricDefinition: "按" + grain + (grain === "周" ? "（周日至周六）" : "") +
      "聚合可计算的 MT/ST 日 OEE 并等权平均；极值按未舍入值比较，并列取最早期间",
  };
}

export function createExtremesTemplate(): DashboardTableWidget {
  return {
    ...empty(), id: "oee-extremes-table-2026", kind: "table", size: "medium", title: "OEE 极值明细（周/月/季）",
    encoding: { columns: [
      { key: "grain", label: "粒度" }, { key: "period_label", label: "期间" }, { key: "point_type", label: "类型" },
      { key: "oee_percent", label: "OEE %" }, { key: "availability_percent", label: "Availability %" },
      { key: "dut_on_percent", label: "Performance (DUT-On) %" },
      { key: "test_time_percent", label: "Performance (Test Time) %" }, { key: "yield_percent", label: "Yield %" },
      { key: "calculable_day_type_count", label: "可计算日类型数" },
    ] },
    format: { unit: "%", precision: 2 },
    metricDefinition: "周/月/季的 MT/ST 日 OEE 等权平均极值；四个组成项与 OEE 均使用同一期间 OEE 可计算日类型的等权平均值",
  };
}

export function createMachineExtremesTemplate(): DashboardTableWidget {
  return {
    ...empty(), id: "mt-st-components-2026", kind: "table", size: "wide",
    title: "OEE 机台 TOP10（周/月/季）· 极值单项对应",
    encoding: { columns: [
      { key: "grain", label: "粒度" }, { key: "point_type", label: "极值" }, { key: "period_label", label: "周期" },
      { key: "oee_percent", label: "周期OEE%" }, { key: "top10_machines", label: "TOP10 机台（机台 OEE 最低）" },
    ] },
    format: { unit: "%", precision: 2 },
    metricDefinition: "与 OEE 极值明细（周/月/季）逐项对应；周期 OEE 沿用日类型等权平均。机台 OEE 按同一周期整期汇总：运行秒数÷（有效 Availability 业务日数×86400）×SUM(IN_QTY)÷SUM(DUT_NUM)×[SUM(同日同类型截尾标准秒数×机台TD次数)÷SUM(机台实际测试秒数)]×SUM(OUT_QTY)÷SUM(IN_QTY)×100；标准秒数来自当日该类型全部合格 DUT，含无匹配 Availability 的记录；MT/ST 合并为一台，按 Availability 累计时长标注主要类型，并列取 MT。按未舍入机台 OEE 升序取最低 10 台，并列按机台编号；不足 10 台展示实际数量。年初首周及截至业务日的未完整月、季按实际范围统计，缺日不会补零。",
  };
}

export function createAnalysisTemplate(key: PeriodKey): DashboardTableWidget {
  return {
    ...empty(), id: "improvement-actions-" + key + "-2026", kind: "table", size: "medium",
    title: "改善措施与责任人 · " + PERIOD_GRAINS[key],
    encoding: { columns: [
      { key: "kind", label: "类型" }, { key: "priority", label: "优先级" }, { key: "issue", label: "问题（损失源）" },
      { key: "measure", label: "改善措施" }, { key: "suggested_owner", label: "建议责任人" }, { key: "loss_hours", label: "本期损失小时" },
    ] },
    format: { unit: "", precision: 1 },
    metricDefinition: "问题、优先级、措施与责任职能由临时 Agent 根据查询证据生成；损失小时仅引用本期实测记录，无法直接量化时为 NULL",
  };
}

const CARD_TEMPLATES = [
  ...(["MT", "ST"] as const).flatMap((kind) => [createOverviewTemplate(kind, true), createOverviewTemplate(kind, false)]),
  ...PERIOD_KEYS.map(createTrendTemplate), createExtremesTemplate(), createMachineExtremesTemplate(),
  ...PERIOD_KEYS.map(createAnalysisTemplate),
];
export const DEFAULT_CARD_IDS: readonly string[] = CARD_TEMPLATES.map((widget) => widget.id);

export function createDefaultDashboard(now = new Date()): DashboardState {
  // Parsing validates the templates and gives every session its own copy.
  return parseDashboardState({ schemaVersion: 1, revision: 0, dataAsOf: now.toISOString(),
    dateRange: { start: null, end: null }, widgets: CARD_TEMPLATES });
}
