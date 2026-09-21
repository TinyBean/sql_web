import type { DashboardOverviewWidget, DashboardRow } from "../../../shared/dashboard.ts";
import type { DatePeriod } from "../../database/business-dates.ts";

function averagePercent(rows: readonly DashboardRow[], column: string): number | null {
  const values = rows.map((row) => row[column]).filter((value): value is number => typeof value === "number");
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length * 100 : null;
}

/** Each card uses only its own type's calculable daily OEE rows, as before. */
export function buildTypeOverviews(
  daily: readonly DashboardRow[],
  range: DatePeriod,
  syncWarnings: readonly string[] = [],
): DashboardOverviewWidget[] {
  return (["MT", "ST"] as const).map((kind) => {
    const rows = daily.filter((row) => row["kind"] === kind);
    const valid = rows.filter((row) => typeof row["daily_test_oee"] === "number");
    const warnings = [...syncWarnings];
    if (valid.length < rows.length) {
      const availabilityMissing = rows.filter((row) => !row["availability_rows"]).length;
      const dutMissing = rows.filter((row) => !row["dut_rows"]).length;
      warnings.push(`${kind} 可计算业务日 ${valid.length}/${rows.length}；缺 Availability ${availabilityMissing} 天、缺 DUT ${dutMissing} 天；缺失或零分母为 NULL，五项指标仅使用 OEE 可计算日`);
    }
    if (!valid.some((row) => row["day"] === range.end)) {
      warnings.push(`最新业务日 ${range.end} 的 ${kind} OEE 尚未可计算`);
    }
    return {
      id: kind.toLowerCase() + "-oee-overview", kind: "overview", size: "wide",
      title: kind + " · OEE 概览",
      subtitle: `业务日 ${range.start} 至 ${range.end}（每天 08:30 至次日 08:30）`,
      data: [{
        overall_oee_percent: averagePercent(valid, "daily_test_oee"),
        avg_availability_percent: averagePercent(valid, "availability"),
        avg_dut_on_percent: averagePercent(valid, "dut_on"),
        avg_test_time_percent: averagePercent(valid, "test_time_performance"),
        avg_performance_percent: averagePercent(valid, "dut_on"),
        avg_yield_percent: averagePercent(valid, "final_yield"),
      }],
      encoding: {
        value: "overall_oee_percent", label: "Overall OEE",
        description: `${kind} 日 OEE 等权平均；覆盖 ${valid.length}/${rows.length} 个可计算业务日`,
        gauges: [
          { name: "Availability", column: "avg_availability_percent" },
          { name: "Performance (DUT-On)", column: "avg_dut_on_percent" },
          { name: "Performance (Test Time)", column: "avg_test_time_percent" },
          { name: "Yield", column: "avg_yield_percent" },
        ],
      },
      format: { unit: "%", precision: 2 },
      metricDefinition: `${kind} Overall OEE = AVG(${kind} 日 Test OEE)×100；日 Test OEE = Availability×Performance (DUT-On)×Performance (Test Time)×Yield。五项指标分别对该类型 OEE 可计算日等权平均；OEE 不由组成项的平均值再次相乘。沿用有效 LOT、PCIe 排除及 MT/ST 分类规则，缺失或零分母保持 NULL。`,
      warnings,
    };
  });
}
