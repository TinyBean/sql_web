import type { DatabaseSync } from "node:sqlite";
import { parseDashboardState, type DashboardRow, type DashboardState, type DashboardWidget,
  type DashboardOverviewWidget, type DashboardTableWidget } from "../../../../shared/dashboard.ts";
import { formatDisplayNumber } from "../../../../shared/number-format.ts";
import { addDays, assertDate, type DatePeriod } from "../../../database/business-dates.ts";
import { EFFECTIVE_DUT_ON, getPeriodTestOeeSql, type MachinePeriodGrain } from "../../../skills/test-oee-calculator/assets/test-oee-calculator.ts";
import { machinePeriodSql } from "../../../skills/test-oee-calculator/assets/machine-metrics.ts";
import { machineLabel, machinePlatform } from "../../../skills/test-oee-calculator/assets/machine-platforms.ts";
import { createDefaultDashboard, fillCardTemplate, createOverviewTemplate, createTrendTemplate,
  createExtremesTemplate, createMachineExtremesTemplate, createAnalysisTemplate } from "../template.ts";
import { dashboardPeriods, periodLabel, isPartialPeriod, PERIOD_KEYS, ANALYSIS_PERIOD_KEYS,
  PERIOD_GRAINS, type PeriodKey } from "./periods.ts";
import { buildDailyMachineCards, readDailyMachines } from "./daily-machines.ts";

interface PeriodData extends DatePeriod {
  readonly label: string;
  readonly rows: readonly DashboardRow[];
}

function metric(row: DashboardRow | undefined, column: string): number | null {
  const value = row?.[column];
  return typeof value === "number" ? value : null;
}

function percentage(value: number | null): number | null {
  return value === null ? null : value * 100;
}

function periodMetric(period: PeriodData, column: string): number | null {
  return metric(period.rows.find((row) => row["kind"] === "ALL"), column);
}

function groupPeriods(rows: readonly DashboardRow[]): PeriodData[] {
  const groups = new Map<string, DashboardRow[]>();
  for (const row of rows) {
    const label = String(row["period_label"]);
    const group = groups.get(label) ?? [];
    group.push(row);
    groups.set(label, group);
  }
  return [...groups.entries()].map(([label, group]) => ({
    label, start: String(group[0]!["period_start"]), end: String(group[0]!["period_end"]), rows: group,
  }));
}

function extremes(periods: readonly PeriodData[]): { high?: PeriodData; low?: PeriodData } {
  let high: PeriodData | undefined;
  let low: PeriodData | undefined;
  let highValue = -Infinity;
  let lowValue = Infinity;
  for (const period of periods) {
    const value = periodMetric(period, "test_oee");
    if (value === null) continue;
    if (value > highValue) { high = period; highValue = value; }
    if (value < lowValue) { low = period; lowValue = value; }
  }
  return { ...(high ? { high } : {}), ...(low ? { low } : {}) };
}

/** Caller owns the read transaction, also used by daily analysis queries. */
export function calculateDefaultDashboard(
  database: DatabaseSync,
  throughDate: string,
  now = new Date(),
  syncWarnings: readonly string[] = [],
  machineRows?: readonly DashboardRow[],
): DashboardState {
  const periods = dashboardPeriods(throughDate);
  // At most 1098 pooled day/scope rows. This read-only batch intentionally
  // does not use the interactive SQL tool's 200-row display limit.
  const daily = readPeriodOee(database, periods.trend, "day");
  const pooled = readPeriodOee(database, periods.trend, "report_period");
  const commonWarnings = [...syncWarnings, ...coverageWarnings(pooled)];
  const latest = daily.filter((row) => row["period_label"] === throughDate && row["kind"] !== "ALL");
  if (latest.filter((row) => typeof row["test_oee"] === "number").length < 2) commonWarnings.push("最新业务日 " + throughDate + " 的 MT/ST OEE 尚未全部可计算");
  const cards = new Map<string, DashboardWidget>(buildTypeOverviews(pooled, periods.trend, syncWarnings, latest)
    .map((widget) => [widget.id, widget]));
  const rangeText = periods.trend.start + " 至 " + throughDate;

  const extremeRows: DashboardRow[] = [];
  for (const key of PERIOD_KEYS) {
    const grain = PERIOD_GRAINS[key];
    const template = createTrendTemplate(key);
    const grouped = groupPeriods(readPeriodOee(database, periods.trend, key));
    const { high, low } = extremes(grouped);
    const partials = grouped.filter((period) => isPartialPeriod(period, grain));
    const warnings = [...commonWarnings];
    if (partials.length) warnings.push("部分" + grain + "：" + partials.map((period) => period.label).join("、") + "；与完整周期比较时需注意覆盖天数");
    if (grain === "周") warnings.push("业务周为周日至周六；周标签采用周日起始的 %U 编号，年初首个周日之前为 W00");
    cards.set(template.id, {
      ...template,
      title: template.title + "（" + periods.year + " 年至今）",
      subtitle: rangeText + " · MT/ST 周期池化 OEE",
      warnings,
      data: grouped.map((period) => ({
        period_label: period.label,
        oee_percent: percentage(periodMetric(period, "test_oee")),
        max_point: period === high ? percentage(periodMetric(period, "test_oee")) : null,
        min_point: period === low ? percentage(periodMetric(period, "test_oee")) : null,
      })),
    });
    for (const [pointType, period] of [["最高", high], ["最低", low]] as const) {
      if (!period) continue;
      extremeRows.push({
        grain, period_label: period.label, point_type: pointType,
        oee_percent: percentage(periodMetric(period, "test_oee")),
        availability_percent: percentage(periodMetric(period, "availability")),
        performance_percent: percentage(periodMetric(period, "dut_on")),
        dut_on_percent: percentage(periodMetric(period, "dut_on")),
        test_time_percent: percentage(periodMetric(period, "test_time_performance")),
        yield_percent: percentage(periodMetric(period, "final_yield")),
        calculable_day_type_count: periodMetric(period, "calculable_day_type_count"),
      });
    }
  }
  const extremesTemplate = createExtremesTemplate();
  cards.set(extremesTemplate.id, {
    ...extremesTemplate,
    subtitle: rangeText + " · 并列极值取最早期间；NULL 不参与排名",
    data: extremeRows, warnings: commonWarnings,
  });
  const machines = buildMachineExtremesTable(database, extremeRows, periods.trend, commonWarnings);
  cards.set(machines.id, machines);
  for (const card of prepareAnalysisCards(database, throughDate, syncWarnings)) cards.set(card.id, card);
  for (const card of buildDailyMachineCards(machineRows ?? readDailyMachines(database, throughDate), throughDate, syncWarnings)) cards.set(card.id, card);
  const template = createDefaultDashboard(now);
  return parseDashboardState({ ...template, dateRange: periods.trend,
    widgets: template.widgets.map((widget) => {
      const values = cards.get(widget.id);
      if (!values) throw new Error("卡片缺少计算结果：" + widget.id);
      return fillCardTemplate(widget, values);
    }),
  });
}

export function readPeriodOee(
  database: DatabaseSync, range: DatePeriod, grain: MachinePeriodGrain | "report_period",
): DashboardRow[] {
  return database.prepare(getPeriodTestOeeSql(range.start, range.end, grain).sql).all().map((row) => {
    const output: Record<string, string | number | null> = {};
    for (const [key, value] of Object.entries(row)) {
      if (value !== null && typeof value !== "string" &&
          !(typeof value === "number" && Number.isFinite(value))) throw new Error("默认看板查询含无效值：" + key);
      output[key] = value;
    }
    return output;
  });
}

function coverageWarnings(rows: readonly DashboardRow[]): string[] {
  const combined = rows.filter((row) => row["kind"] === "ALL");
  const sum = (column: string): number => combined.reduce((total, row) => total+Number(row[column] ?? 0), 0);
  const count = sum("calculable_day_type_count"), selected = sum("selected_day_type_count");
  if (count === selected) return [];
  return [`可计算日类型 ${count}/${selected}；缺 Availability ${selected-sum("availability_day_type_count")} 个、缺 DUT ${selected-sum("dut_day_type_count")} 个；各指标独立池化已有数据，缺失或零分母保持 NULL`];
}

/** Cards project the shared period query; coverage describes data without filtering it. */
export function buildTypeOverviews(
  pooled: readonly DashboardRow[],
  range: DatePeriod,
  syncWarnings: readonly string[] = [],
  latest?: readonly DashboardRow[],
): DashboardOverviewWidget[] {
  return (["MT", "ST"] as const).flatMap((kind) => ([true, false] as const).map((effective) => {
    const template = createOverviewTemplate(kind, effective);
    const label = template.encoding.label;
    const column = effective ? "effective_oee" : "test_oee";
    const prefix = effective ? "avg_effective_" : "avg_";
    const row = pooled.find((row) => row["kind"] === kind);
    const selected = Number(row?.["selected_day_count"] ?? (Date.parse(range.end)-Date.parse(range.start))/86_400_000+1);
    const count = Number(row?.[effective ? "effective_calculable_day_type_count" : "calculable_day_type_count"] ?? 0);
    const warnings = [...syncWarnings];
    if (count < selected) {
      warnings.push(`${kind} ${label} 可计算业务日 ${count}/${selected}；缺 Availability ${selected-Number(row?.["availability_day_type_count"] ?? 0)} 天、缺 DUT ${selected-Number(row?.["dut_day_type_count"] ?? 0)} 天；各指标独立池化已有数据，缺失或零分母保持 NULL`);
    }
    if (latest && !latest.some((r) => r["kind"] === kind && typeof r[column] === "number")) {
      warnings.push(`最新业务日 ${range.end} 的 ${kind} ${label} 尚未可计算`);
    }
    return {
      ...template,
      subtitle: `业务日 ${range.start} 至 ${range.end}（每天 08:30 至次日 08:30）`,
      data: [{
        [template.encoding.value]: percentage(metric(row, column)),
        [prefix + "availability_percent"]: percentage(metric(row, effective ? "effective_availability" : "availability")),
        [prefix + "dut_on_percent"]: percentage(effective ? EFFECTIVE_DUT_ON : metric(row, "dut_on")),
        [prefix + "test_time_percent"]: percentage(metric(row, "test_time_performance")),
        [prefix + "yield_percent"]: percentage(metric(row, "final_yield")),
        ...(!effective ? { avg_performance_percent: percentage(metric(row, "dut_on")) } : {}),
      }],
      encoding: { ...template.encoding,
        description: `${kind} 周期池化 ${label}；日可计算覆盖 ${count}/${selected}，各来源独立汇总${effective ? "；DUT-On 固定89.5%" : ""}`,
      },
      warnings,
    };
  }));
}

interface MachineOee {
  readonly machine: string;
  readonly kind: string;
  readonly oee: number | null;
  readonly availabilityDays: number;
  readonly dutDays: number;
}

function queryMachines(database: DatabaseSync, period: DatePeriod): MachineOee[] {
  const rows = database.prepare(machinePeriodSql(period)).all();
  return rows.map((row) => {
    const { machine, kind, oee, availability_days: availabilityDays, dut_days: dutDays } = row;
    if (typeof machine !== "string" || typeof kind !== "string" ||
        typeof availabilityDays !== "number" || typeof dutDays !== "number" ||
        (oee !== null && (typeof oee !== "number" || !Number.isFinite(oee)))) {
      throw new Error("机台 OEE 查询含无效值");
    }
    return { machine, kind, oee, availabilityDays, dutDays };
  });
}

/** Uses the caller's read transaction and the already selected fleet extrema. */
export function buildMachineExtremesTable(
  database: DatabaseSync,
  extremeRows: readonly DashboardRow[],
  range: DatePeriod,
  sourceWarnings: readonly string[] = [],
): DashboardTableWidget {
  assertDate(range.start);
  assertDate(range.end);
  if (range.start > range.end) throw new Error("机台排名开始日期不能晚于结束日期");
  const ranges = new Map<string, DatePeriod>();
  for (let day = range.start; day <= range.end; day = addDays(day, 1)) {
    for (const grain of ["周", "月", "季"] as const) {
      const key = grain + periodLabel(day, grain);
      ranges.set(key, { start: ranges.get(key)?.start ?? day, end: day });
    }
  }
  const cache = new Map<string, MachineOee[]>();
  const warnings = new Set(sourceWarnings);
  const missingPlatforms = new Set<string>();
  const data: DashboardRow[] = [];
  for (const grain of ["周", "月", "季"] as const) {
    for (const pointType of ["最低", "最高"] as const) {
      const row = extremeRows.find((item) => item["grain"] === grain && item["point_type"] === pointType);
      if (!row) continue;
      const period = ranges.get(grain + String(row["period_label"]));
      if (!period) throw new Error("机台排名周期不在看板日期范围内：" + row["period_label"]);
      const key = period.start + "/" + period.end;
      let machines = cache.get(key);
      if (!machines) {
        machines = queryMachines(database, period);
        cache.set(key, machines);
      }
      const calculable = machines.filter((machine) => machine.oee !== null);
      const top = calculable.slice(0, 10);
      data.push({
        grain, point_type: pointType, period_label: row["period_label"] ?? null,
        oee_percent: row["oee_percent"] ?? null,
        top10_machines: top.length ? top.map((machine, index) =>
          `${index + 1}.${machineLabel(machine.machine)}(${machine.kind} ${formatDisplayNumber(machine.oee!)}%)`).join("、") : null,
      });
      for (const machine of top) {
        if (!machinePlatform(machine.machine)) missingPlatforms.add(machine.machine);
      }
      const selectedDays = (Date.parse(period.end) - Date.parse(period.start)) / 86_400_000 + 1;
      const coverage = (column: "availabilityDays" | "dutDays"): string => {
        const days = top.map((machine) => machine[column]);
        return Math.min(...days) + "–" + Math.max(...days) + "/" + selectedDays;
      };
      warnings.add(`${grain} ${row["period_label"]}（${period.start} 至 ${period.end}）：` +
        `可计算机台 ${calculable.length}/${machines.length}，展示 ${top.length} 台；` +
        (top.length ? `入榜机台 Availability 覆盖 ${coverage("availabilityDays")} 天，DUT 覆盖 ${coverage("dutDays")} 天；` : "") +
        "缺失或零分母为 NULL，不参与排名");
    }
  }
  if (missingPlatforms.size) warnings.add(("平台映射待维护 " + missingPlatforms.size + " 台：" +
    [...missingPlatforms].slice(0, 5).map(machineLabel).join("、") + "；请补充机台平台映射").slice(0, 300));
  return {
    ...createMachineExtremesTemplate(),
    subtitle: "与 OEE 极值明细逐项对应的机台 TOP10 · 本机台周期 Test Time 1% 截尾、上限 100%",
    data, warnings: [...warnings],
  };
}

function prepareAnalysisCards(
  database: DatabaseSync, throughDate: string, syncWarnings: readonly string[] = [],
): DashboardTableWidget[] {
  const periods = dashboardPeriods(throughDate);
  return ANALYSIS_PERIOD_KEYS.map((key) => {
    const period = periods[key];
    const template = createAnalysisTemplate(key);
    const periodText = period.start + " 至 " + period.end;
    const grain = PERIOD_GRAINS[key];
    const label = key === "day" ? period.end : periodLabel(key === "week" ? period.start : period.end, PERIOD_GRAINS[key]);
    const subtitle = key === "day" ? "最新业务日 · " + period.end : (key === "week" ? "最近完整周" : grain + "累计") + " · " + periodText;
    const warnings = [...syncWarnings, ...coverageWarnings(readPeriodOee(database, period, "report_period")),
      "本次分析暂不可用：尚未生成临时 Agent 报告", "责任人列为职能建议，需管理层确认后指派到人"];
    return {
      ...template, title: template.title + "（" + label + "）",
      subtitle: subtitle + " · 临时 Agent 分析",
      metricDefinition: periodText + " 的" + template.metricDefinition, warnings,
    };
  });
}

export interface AnalysisLossCandidate {
  readonly priority: number;
  readonly state_group: string;
  readonly loss_hours: number;
  readonly row_index: number;
}

/** Rank complete state totals before display rounding, retaining the audited row index. */
export function selectLosses(rows: readonly DashboardRow[], kind: "MT" | "ST"): AnalysisLossCandidate[] {
  return rows.map((row, row_index) => ({ row, row_index }))
    .filter(({ row }) => row["kind"] === kind && typeof row["state_group"] === "string" &&
      typeof row["loss_hours"] === "number" && Number.isFinite(row["loss_hours"]))
    .sort((a, b) => Number(b.row["loss_hours"]) - Number(a.row["loss_hours"]) ||
      (String(a.row["state_group"]) < String(b.row["state_group"]) ? -1 : String(a.row["state_group"]) > String(b.row["state_group"]) ? 1 : 0))
    .slice(0, 3).map(({ row, row_index }, index) => ({ priority: index + 1,
      state_group: String(row["state_group"]), loss_hours: Number(row["loss_hours"]), row_index }));
}

/** Use frozen source rows and fleet extrema without changing evidence ownership. */
export function minimumComparisonPeriod(
  state: DashboardState, daily: readonly DashboardRow[], throughDate: string, key: PeriodKey,
): DatePeriod | undefined {
  const periods = dashboardPeriods(throughDate);
  if (key === "day") {
    // Source rows are day-ordered; the shared extrema calculation keeps the earliest tie.
    const { low } = extremes(groupPeriods(daily));
    return low ? { start: low.start, end: low.end } : undefined;
  }
  const grain = PERIOD_GRAINS[key];
  const minimum = state.widgets.find((widget) => widget.id === createExtremesTemplate().id)?.data
    .find((row) => row["grain"] === grain && row["point_type"] === "最低");
  const days: string[] = [];
  for (let day = periods.trend.start; day <= throughDate; day = addDays(day, 1)) {
    if (periodLabel(day, grain) === minimum?.["period_label"]) days.push(day);
  }
  return days.length ? { start: days[0]!, end: days.at(-1)! } : undefined;
}

export function summarizePeriodOee(pooled: readonly DashboardRow[]) {
  return ["MT", "ST"].map((kind) => {
    const row = pooled.find((row) => row["kind"] === kind);
    return {
      kind, selected_days: Number(row?.["selected_day_count"] ?? 0),
      calculable_days: Number(row?.["calculable_day_type_count"] ?? 0),
      availability_days: Number(row?.["availability_day_type_count"] ?? 0),
      dut_days: Number(row?.["dut_day_type_count"] ?? 0),
      metrics: Object.fromEntries(["test_oee", "effective_oee", "availability", "effective_availability", "idle", "idle_no_wip",
        "dut_on", "effective_dut_on", "test_time_performance", "final_yield"].map((column) => [column, metric(row, column)])),
    };
  });
}
