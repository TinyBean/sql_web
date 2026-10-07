import type { MachineDatePeriod as DatePeriod } from "./runtime.ts";
import { getTestOeeSqlExpressions, getTestOeeDutCtes } from "./test-oee-calculator.ts";

/** Preserve the existing full-period fleet-standard formula; optionally keep MT/ST separate. */
export function machinePeriodSql(period: DatePeriod, byKind = false): string {
  const a = getTestOeeSqlExpressions("availability", period.start, period.end, "a");
  return `WITH
availability_classified AS (
  SELECT ${a.dayExpression} AS day, ${a.machineExpression} AS machine,
    ${a.kindExpression} AS kind, ${a.availabilityStateExpression} AS state_group,
    ${a.idlePredicate} AS is_idle,
    CAST(a.time_span AS REAL) AS state_seconds
  FROM oee_availability AS a
  WHERE ${a.dateRangePredicate} AND ${a.sourceLotPredicate} AND ${a.platformPredicate}
),
availability_period AS (
  SELECT machine, COUNT(DISTINCT day) AS availability_days,
    ${byKind ? "kind" : "CASE WHEN SUM(CASE WHEN kind='MT' THEN state_seconds ELSE 0 END) >= SUM(CASE WHEN kind='ST' THEN state_seconds ELSE 0 END) THEN 'MT' ELSE 'ST' END"} AS kind,
    SUM(CASE WHEN state_group='Machine_Running' THEN state_seconds ELSE 0 END)
      / NULLIF(SUM(state_seconds), 0) AS availability,
    SUM(CASE WHEN is_idle THEN state_seconds ELSE 0 END) / NULLIF(SUM(state_seconds), 0) AS idle
  FROM availability_classified
  WHERE kind IN ('MT','ST')
  GROUP BY machine${byKind ? ", kind" : ""}
),
${getTestOeeDutCtes(period.start, period.end)},
machine_dut_daily AS (
  SELECT machine, day, kind,
    SUM(input_quantity) AS input_quantity,
    SUM(CASE WHEN yield_eligible THEN input_quantity END) AS yield_input_quantity,
    SUM(CASE WHEN yield_eligible THEN output_quantity END) AS yield_output_quantity,
    SUM(socket_quantity) AS socket_quantity, SUM(touchdown_label) AS touchdown_count,
    SUM(test_time_seconds) AS actual_test_seconds
  FROM dut_base
  WHERE kind IN ('MT','ST')
  GROUP BY machine, day, kind
),
dut_period AS (
  SELECT q.machine, ${byKind ? "q.kind," : ""} COUNT(DISTINCT q.day) AS dut_days,
    SUM(q.input_quantity) / NULLIF(SUM(q.socket_quantity), 0) AS dut_on,
    SUM(q.yield_output_quantity) / NULLIF(SUM(q.yield_input_quantity), 0) AS final_yield,
    CASE WHEN COUNT(t.trimmed_mean_test_seconds) < COUNT(*) THEN NULL
      ELSE SUM(t.trimmed_mean_test_seconds * q.touchdown_count)
        / NULLIF(SUM(q.actual_test_seconds), 0) END AS test_time_performance
  FROM machine_dut_daily AS q
  LEFT JOIN duration_trimmed AS t ON t.day=q.day AND t.kind=q.kind
  GROUP BY q.machine${byKind ? ", q.kind" : ""}
)
SELECT a.machine, a.kind, a.availability_days, COALESCE(d.dut_days, 0) AS dut_days,
  a.availability * 100 AS availability, d.dut_on * 100 AS dut_on,
  d.test_time_performance * 100 AS test_time_performance, d.final_yield * 100 AS final_yield,
  (a.availability + a.idle / NULLIF(1 + (1 - a.idle - a.availability), 0)) * 100 AS effective_availability,
  a.availability * d.dut_on * d.test_time_performance * d.final_yield * 100 AS oee,
  (a.availability + a.idle / NULLIF(1 + (1 - a.idle - a.availability), 0))
    * d.dut_on * d.test_time_performance * d.final_yield * 100 AS effective_oee
FROM availability_period AS a
LEFT JOIN dut_period AS d ON d.machine=a.machine${byKind ? " AND d.kind=a.kind" : ""}
ORDER BY oee, a.machine`;
}
