import type { DashboardOverviewWidget, DashboardRow } from "../../../shared/dashboard.ts";
import type { DatePeriod } from "../../database/business-dates.ts";

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
    const label = effective ? "Effective OEE" : "Test OEE";
    const dailyColumn = effective ? "daily_effective_oee" : "daily_test_oee";
    const valueColumn = effective ? "overall_effective_oee_percent" : "overall_oee_percent";
    const availabilityColumn = effective ? "avg_effective_availability_percent" : "avg_availability_percent";
    const dutColumn = effective ? "avg_effective_dut_on_percent" : "avg_dut_on_percent";
    const timeColumn = effective ? "avg_effective_test_time_percent" : "avg_test_time_percent";
    const yieldColumn = effective ? "avg_effective_yield_percent" : "avg_yield_percent";
    const availabilityName = effective ? "Effective Availability" : "Availability";
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
      id: kind.toLowerCase() + (effective ? "-effective-oee-overview" : "-oee-overview"), kind: "overview", size: "medium",
      title: kind + " · " + label,
      subtitle: `业务日 ${range.start} 至 ${range.end}（每天 08:30 至次日 08:30）`,
      data: [{
        [valueColumn]: averagePercent(valid, dailyColumn),
        [availabilityColumn]: averagePercent(valid, effective ? "effective_availability" : "availability"),
        [dutColumn]: averagePercent(valid, "dut_on"),
        [timeColumn]: averagePercent(valid, "test_time_performance"),
        ...(!effective ? { avg_performance_percent: averagePercent(valid, "dut_on") } : {}),
        [yieldColumn]: averagePercent(valid, "final_yield"),
      }],
      encoding: {
        value: valueColumn, label,
        description: `${kind} 日 ${label} 等权平均；覆盖 ${valid.length}/${rows.length} 个可计算业务日`,
        gauges: [
          { name: availabilityName, column: availabilityColumn },
          { name: "Performance (DUT-On)", column: dutColumn },
          { name: "Performance (Test Time)", column: timeColumn },
          { name: "Yield", column: yieldColumn },
        ],
      },
      format: { unit: "%", precision: 2 },
      metricDefinition: `${kind} ${label} = AVG(${kind} 日 ${label})×100；日 ${label} = ${availabilityName}×Performance (DUT-On)×Performance (Test Time)×Yield。` +
        (effective ? "Effective Availability = Availability + Idle / (1 + (1 - Idle - Availability))。" : "") +
        `五项指标分别对该类型 ${label} 可计算日等权平均；OEE 不由组成项的平均值再次相乘。沿用有效 LOT、PCIe 排除及 MT/ST 分类规则，缺失或零分母保持 NULL。`,
      warnings,
    };
  }));
}
