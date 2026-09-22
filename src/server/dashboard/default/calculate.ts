import type { DatabaseSync } from "node:sqlite";
import type { DashboardRow, DashboardWidget } from "../../../shared/dashboard.ts";
import type { DatePeriod } from "../../database/business-dates.ts";
import { createTrendTemplate, createExtremesTemplate } from "./template.ts";
import { dashboardPeriods, periodLabel, isPartialPeriod, PERIOD_KEYS, PERIOD_GRAINS } from "./periods.ts";
import { readDailyOee, calculable, coverageWarnings } from "./data.ts";
import { buildMachineExtremesTable } from "./machine-extremes.ts";
import { buildTypeOverviews } from "./overviews.ts";

type Grain = "周" | "月" | "季";
interface PeriodData extends DatePeriod {
  readonly label: string;
  readonly rows: readonly DashboardRow[];
}

function average(rows: readonly DashboardRow[], column: string): number | null {
  const values = rows.map((row) => row[column]).filter((value): value is number => typeof value === "number");
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
}

function percentage(value: number | null): number | null {
  return value === null ? null : Math.round(value * 10_000) / 100;
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

/** Caller owns the read transaction, also used by daily analysis queries. */
export function calculateNumericCards(
  database: DatabaseSync,
  throughDate: string,
  syncWarnings: readonly string[] = [],
): DashboardWidget[] {
  const periods = dashboardPeriods(throughDate);
  // At most 732 aggregate day/type rows. This read-only batch intentionally
  // does not use the interactive SQL tool's 200-row display limit.
  const daily = readDailyOee(database, periods.trend);
  const commonWarnings = [...syncWarnings, ...coverageWarnings(daily)];
  const latest = daily.filter((row) => row["day"] === throughDate);
  if (calculable(latest).length < 2) commonWarnings.push("最新业务日 " + throughDate + " 的 MT/ST OEE 尚未全部可计算");
  const widgets: DashboardWidget[] = buildTypeOverviews(daily, periods.trend, syncWarnings);
  const rangeText = periods.trend.start + " 至 " + throughDate;

  const extremeRows: DashboardRow[] = [];
  for (const key of PERIOD_KEYS) {
    const grain = PERIOD_GRAINS[key];
    const template = createTrendTemplate(key);
    const grouped = groupPeriods(daily, grain);
    const { high, low } = extremes(grouped);
    const partials = grouped.filter((period) => isPartialPeriod(period, grain));
    const warnings = [...commonWarnings];
    if (partials.length) warnings.push("部分" + grain + "：" + partials.map((period) => period.label).join("、") + "；与完整周期比较时需注意覆盖天数");
    if (grain === "周") warnings.push("业务周为周日至周六；周标签采用周日起始的 %U 编号，年初首个周日之前为 W00");
    widgets.push({
      ...template,
      title: template.title + "（" + periods.year + " 年至今）",
      subtitle: rangeText + " · MT/ST 日 OEE 等权平均",
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
        availability_percent: percentage(average(calculable(period.rows), "availability")),
        performance_percent: percentage(average(calculable(period.rows), "dut_on")),
        dut_on_percent: percentage(average(calculable(period.rows), "dut_on")),
        test_time_percent: percentage(average(calculable(period.rows), "test_time_performance")),
        yield_percent: percentage(average(calculable(period.rows), "final_yield")),
        calculable_day_type_count: calculable(period.rows).length,
      });
    }
  }
  widgets.push({
    ...createExtremesTemplate(),
    subtitle: rangeText + " · 并列极值取最早期间；NULL 不参与排名",
    data: extremeRows, warnings: commonWarnings,
  });
  widgets.push(buildMachineExtremesTable(database, extremeRows, periods.trend, commonWarnings));
  return widgets;
}
