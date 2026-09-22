import type { DashboardOverviewWidget, DashboardRow } from "../../../shared/dashboard.ts";
import type { DatePeriod } from "../../database/business-dates.ts";
import { createOverviewTemplate } from "./template.ts";

function averagePercent(rows: readonly DashboardRow[], column: string): number | null {
  const values = rows.map((row) => row[column]).filter((value): value is number => typeof value === "number");
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length * 100 : null;
}

/** Each metric uses its own type and calculable daily sample for all five values. */
export function buildTypeOverviews(
  daily: readonly DashboardRow[],
  range: DatePeriod,
  syncWarnings: readonly string[] = [],
): DashboardOverviewWidget[] {
  return (["MT", "ST"] as const).flatMap((kind) => ([true, false] as const).map((effective) => {
    const template = createOverviewTemplate(kind, effective);
    const label = template.encoding.label;
    const dailyColumn = effective ? "daily_effective_oee" : "daily_test_oee";
    const prefix = effective ? "avg_effective_" : "avg_";
    const rows = daily.filter((row) => row["kind"] === kind);
    const valid = rows.filter((row) => typeof row[dailyColumn] === "number");
    const warnings = [...syncWarnings];
    if (valid.length < rows.length) {
      const availabilityMissing = rows.filter((row) => !row["availability_rows"]).length;
      const dutMissing = rows.filter((row) => !row["dut_rows"]).length;
      warnings.push(`${kind} ${label} 可计算业务日 ${valid.length}/${rows.length}；缺 Availability ${availabilityMissing} 天、缺 DUT ${dutMissing} 天；缺失或零分母为 NULL，五项指标仅使用 ${label} 可计算日`);
    }
    if (!valid.some((row) => row["day"] === range.end)) {
      warnings.push(`最新业务日 ${range.end} 的 ${kind} ${label} 尚未可计算`);
    }
    return {
      ...template,
      subtitle: `业务日 ${range.start} 至 ${range.end}（每天 08:30 至次日 08:30）`,
      data: [{
        [template.encoding.value]: averagePercent(valid, dailyColumn),
        [prefix + "availability_percent"]: averagePercent(valid, effective ? "effective_availability" : "availability"),
        [prefix + "dut_on_percent"]: averagePercent(valid, "dut_on"),
        [prefix + "test_time_percent"]: averagePercent(valid, "test_time_performance"),
        [prefix + "yield_percent"]: averagePercent(valid, "final_yield"),
        ...(!effective ? { avg_performance_percent: averagePercent(valid, "dut_on") } : {}),
      }],
      encoding: { ...template.encoding,
        description: `${kind} 日 ${label} 等权平均；覆盖 ${valid.length}/${rows.length} 个可计算业务日`,
      },
      warnings,
    };
  }));
}
