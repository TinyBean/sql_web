import type { MachineDatePeriod as DatePeriod } from "./runtime.ts";
import { getMachineTestOeeCtes } from "./test-oee-calculator.ts";

/** Each machine/type uses its own 1% standard over the selected period. */
export function machinePeriodSql(period: DatePeriod, byKind = false): string {
  const merged = byKind ? "" : `,
availability_merged AS (
  SELECT machine, COUNT(DISTINCT source_day) AS availability_days,
    CASE WHEN SUM(CASE WHEN kind='MT' THEN state_seconds ELSE 0 END)
      >= SUM(CASE WHEN kind='ST' THEN state_seconds ELSE 0 END) THEN 'MT' ELSE 'ST' END AS kind,
    SUM(CASE WHEN state_group='Machine_Running' THEN state_seconds ELSE 0 END)
      / NULLIF(SUM(state_seconds), 0) AS availability,
    SUM(CASE WHEN is_idle THEN state_seconds ELSE 0 END) / NULLIF(SUM(state_seconds), 0) AS idle,
    SUM(CASE WHEN state_group='IDLE_NoWIP' THEN state_seconds ELSE 0 END)
      / NULLIF(SUM(state_seconds), 0) AS idle_no_wip
  FROM availability_classified WHERE kind IN ('MT','ST') GROUP BY machine
),
availability_merged_effective AS (
  SELECT *, availability + idle_no_wip / NULLIF(1 + (1 - idle_no_wip - availability), 0) AS effective_availability
  FROM availability_merged
),
dut_coverage AS (
  SELECT machine, COUNT(DISTINCT source_day) AS dut_days
  FROM dut_base WHERE kind IN ('MT','ST') GROUP BY machine
),
dut_merged_raw AS (
  SELECT q.machine, MAX(c.dut_days) AS dut_days,
    SUM(q.input_quantity) / NULLIF(SUM(q.socket_quantity), 0) AS dut_on,
    SUM(q.yield_output_quantity) / NULLIF(SUM(q.yield_input_quantity), 0) AS final_yield,
    CASE WHEN COUNT(q.raw_test_time_performance)<COUNT(*) THEN NULL
      ELSE SUM(q.trimmed_mean_test_seconds * q.touchdown_count)
        / NULLIF(SUM(q.actual_test_seconds), 0) END AS raw_test_time_performance
  FROM dut_daily_raw q JOIN dut_coverage c ON c.machine=q.machine GROUP BY q.machine
),
dut_merged AS (
  SELECT *, CASE WHEN raw_test_time_performance>1 THEN 1.0
    ELSE raw_test_time_performance END AS test_time_performance
  FROM dut_merged_raw
)`;
  return `WITH ${getMachineTestOeeCtes(period.start, period.end, "report_period")}${merged}
SELECT a.machine, a.kind, a.availability_days, COALESCE(d.dut_days, 0) AS dut_days,
  a.availability * 100 AS availability, d.dut_on * 100 AS dut_on,
  d.raw_test_time_performance * 100 AS raw_test_time_performance,
  d.test_time_performance * 100 AS test_time_performance, d.final_yield * 100 AS final_yield,
  a.effective_availability * 100 AS effective_availability,
  a.availability * d.dut_on * d.test_time_performance * d.final_yield * 100 AS oee,
  a.effective_availability * d.dut_on * d.test_time_performance * d.final_yield * 100 AS effective_oee
FROM ${byKind ? "availability_effective" : "availability_merged_effective"} AS a
LEFT JOIN ${byKind ? "dut_daily" : "dut_merged"} AS d ON d.machine=a.machine${byKind ? " AND d.kind=a.kind" : ""}
ORDER BY oee, a.machine`;
}
