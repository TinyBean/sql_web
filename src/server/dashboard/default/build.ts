import { DatabaseSync } from "node:sqlite";
import { parseDashboardState, type DashboardRow, type DashboardState, type DashboardWidget } from "../../../shared/dashboard.ts";
import { getDefaultTestOeeSql } from "../../skills/test-oee-calculator/assets/test-oee-calculator.ts";
import { createDefaultDashboard } from "./template.ts";
import { dashboardPeriods, periodLabel } from "./periods.ts";
import { addDays, type DatePeriod } from "../../database/business-dates.ts";
import { buildMachineExtremesTable } from "./machine-extremes.ts";
import { buildTypeOverviews } from "./overviews.ts";

type Grain = "周" | "月" | "季";
interface PeriodData extends DatePeriod {
  readonly label: string;
  readonly rows: readonly DashboardRow[];
}

function query(database: DatabaseSync, sql: string): DashboardRow[] {
  return database.prepare(sql).all().map((row) => {
    const output: Record<string, string | number | null> = {};
    for (const [key, value] of Object.entries(row)) {
      if (value !== null && typeof value !== "string" &&
          !(typeof value === "number" && Number.isFinite(value))) {
        throw new Error("默认看板查询含无效值：" + key);
      }
      output[key] = value;
    }
    return output;
  });
}

function average(rows: readonly DashboardRow[], column: string): number | null {
  const values = rows.map((row) => row[column]).filter((value): value is number => typeof value === "number");
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
}

function percentage(value: number | null, rounded = true): number | null {
  return value === null ? null : rounded ? Math.round(value * 10_000) / 100 : value * 100;
}

function calculable(rows: readonly DashboardRow[]): readonly DashboardRow[] {
  return rows.filter((row) => typeof row["daily_test_oee"] === "number");
}

function coverageWarnings(rows: readonly DashboardRow[]): string[] {
  const count = calculable(rows).length;
  if (count === rows.length) return [];
  const availabilityMissing = rows.filter((row) => !row["availability_rows"]).length;
  const dutMissing = rows.filter((row) => !row["dut_rows"]).length;
  return [
    "可计算日类型 " + count + "/" + rows.length + "；缺 Availability " +
      availabilityMissing + " 个、缺 DUT " + dutMissing + " 个；缺失或零分母结果为 NULL，平均仅使用可计算值",
  ];
}

function groupPeriods(rows: readonly DashboardRow[], grain: Grain): PeriodData[] {
  const groups = new Map<string, DashboardRow[]>();
  for (const row of rows) {
    const label = periodLabel(String(row["day"]), grain);
    const group = groups.get(label) ?? [];
    group.push(row);
    groups.set(label, group);
  }
  return [...groups.entries()].map(([label, group]) => ({
    label,
    start: String(group[0]?.["day"]),
    end: String(group.at(-1)?.["day"]),
    rows: group,
  }));
}

function isPartial(period: PeriodData, grain: Grain): boolean {
  const start = new Date(period.start + "T00:00:00.000Z");
  const nextDay = addDays(period.end, 1);
  if (grain === "周") return start.getUTCDay() !== 1 ||
    (Date.parse(nextDay) - Date.parse(period.start)) / 86_400_000 !== 7;
  if (grain === "月") return period.start.slice(8) !== "01" || nextDay.slice(8) !== "01";
  return !["01-01", "04-01", "07-01", "10-01"].includes(period.start.slice(5)) ||
    !["01-01", "04-01", "07-01", "10-01"].includes(nextDay.slice(5));
}

function extremes(periods: readonly PeriodData[]): { high?: PeriodData; low?: PeriodData } {
  let high: PeriodData | undefined;
  let low: PeriodData | undefined;
  let highValue = -Infinity;
  let lowValue = Infinity;
  for (const period of periods) {
    const value = average(period.rows, "daily_test_oee");
    if (value === null) continue;
    if (value > highValue) { high = period; highValue = value; }
    if (value < lowValue) { low = period; lowValue = value; }
  }
  return { ...(high ? { high } : {}), ...(low ? { low } : {}) };
}

export function buildDefaultDashboard(
  databasePath: string,
  throughDate: string,
  now = new Date(),
  syncWarnings: readonly string[] = [],
): DashboardState {
  const database = new DatabaseSync(databasePath, { readOnly: true, timeout: 5_000 });
  try {
    database.exec("BEGIN");
    const state = buildDefaultDashboardInTransaction(database, throughDate, now, syncWarnings);
    database.exec("COMMIT");
    return state;
  } finally {
    database.close();
  }
}

/** Caller owns the read transaction, also used by daily analysis queries. */
export function buildDefaultDashboardInTransaction(
  database: DatabaseSync,
  throughDate: string,
  now = new Date(),
  syncWarnings: readonly string[] = [],
): DashboardState {
  const periods = dashboardPeriods(throughDate);
  // At most 732 aggregate day/type rows. This read-only batch intentionally
  // does not use the interactive SQL tool's 200-row display limit.
  const daily = query(database, getDefaultTestOeeSql(periods.trend.start, periods.trend.end).sql);
  const commonWarnings = [...syncWarnings, ...coverageWarnings(daily)];
  const latest = daily.filter((row) => row["day"] === throughDate);
  if (calculable(latest).length < 2) commonWarnings.push("最新业务日 " + throughDate + " 的 MT/ST OEE 尚未全部可计算");
  const template = createDefaultDashboard();
  const widgets = new Map(template.widgets.map((widget) => [widget.id, widget]));
  const replace = (id: string, change: Partial<DashboardWidget>): void => {
    const original = widgets.get(id);
    if (!original) throw new Error("默认看板缺少卡片：" + id);
    widgets.set(id, { ...original, ...change } as DashboardWidget);
  };
  const rangeText = periods.trend.start + " 至 " + throughDate;
  for (const overview of buildTypeOverviews(daily, periods.trend, syncWarnings)) {
    replace(overview.id, overview);
  }

  const extremeRows: DashboardRow[] = [];
  const grainNames = { "周": "weekly", "月": "monthly", "季": "quarterly" } as const;
  for (const grain of ["周", "月", "季"] as const) {
    const grouped = groupPeriods(daily, grain);
    const { high, low } = extremes(grouped);
    const partials = grouped.filter((period) => isPartial(period, grain));
    const warnings = [...commonWarnings];
    if (partials.length) warnings.push("部分" + grain + "：" + partials.map((period) => period.label).join("、") + "；与完整周期比较时需注意覆盖天数");
    if (grain === "周") warnings.push("周标签采用周一为起始的 %W 编号；年初首个周一之前为 W00");
    replace("oee-trend-" + grainNames[grain] + "-2026", {
      title: "OEE " + grain + "趋势（" + periods.year + " 年至今）",
      subtitle: rangeText + " · MT/ST 日 OEE 等权平均",
      metricDefinition: "按" + grain + "聚合可计算的 MT/ST 日 OEE 并等权平均；极值按未舍入值比较，并列取最早期间",
      warnings,
      data: grouped.map((period) => ({
        period_label: period.label,
        oee_percent: percentage(average(period.rows, "daily_test_oee")),
        max_point: period === high ? percentage(average(period.rows, "daily_test_oee")) : null,
        min_point: period === low ? percentage(average(period.rows, "daily_test_oee")) : null,
      })),
    });
    for (const [pointType, period] of [["最高", high], ["最低", low]] as const) {
      if (!period) continue;
      extremeRows.push({
        grain, period_label: period.label, point_type: pointType,
        oee_percent: percentage(average(period.rows, "daily_test_oee")),
        availability_percent: percentage(average(period.rows, "availability")),
        performance_percent: percentage(average(period.rows, "performance")),
        yield_percent: percentage(average(period.rows, "final_yield")),
        calculable_day_type_count: calculable(period.rows).length,
      });
    }
  }
  replace("oee-extremes-table-2026", {
    subtitle: rangeText + " · 并列极值取最早期间；NULL 不参与排名",
    data: extremeRows, warnings: commonWarnings,
    metricDefinition: "周/月/季的 MT/ST 日 OEE 等权平均极值；组成项为同一期间各自可计算日类型的平均值",
  });
  replace("mt-st-components-2026", buildMachineExtremesTable(database, extremeRows, periods.trend, commonWarnings));
  for (const [key, grain, period] of [
    ["week", "周", periods.week], ["month", "月", periods.month], ["quarter", "季", periods.quarter],
  ] as const) {
    const periodDaily = query(database, getDefaultTestOeeSql(period.start, period.end).sql);
    const label = periodLabel(key === "week" ? period.start : period.end, grain);
    const periodText = period.start + " 至 " + period.end;
    const warnings = [...syncWarnings, ...coverageWarnings(periodDaily), "本次分析暂不可用：尚未生成临时 Agent 报告", "责任人列为职能建议，需管理层确认后指派到人"];
    if (key !== "week" && isPartial({ ...period, label, rows: [] }, grain)) {
      warnings.push("本期为截至 " + throughDate + " 的部分" + grain + "，损失小时不可与完整周期直接对比");
    }
    replace("improvement-actions-" + key + "-2026", {
      title: "改善措施与责任人 · " + grain + "（" + label + "）",
      subtitle: (key === "week" ? "最近完整周" : grain + "累计") + " · " + periodText + " · 临时 Agent 分析",
      data: [],
      metricDefinition: periodText + " 的问题、优先级、措施与责任职能由临时 Agent 根据查询证据生成；损失小时仅引用本期实测记录，无法直接量化时为 NULL",
      warnings,
    });
  }
  const state = parseDashboardState({
    schemaVersion: template.schemaVersion, revision: 0, dataAsOf: now.toISOString(),
    dateRange: periods.trend, widgets: [...widgets.values()],
  });
  return state;
}
