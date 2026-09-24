import type { DatabaseSync } from "node:sqlite";
import type { DashboardRow, DashboardTableWidget } from "../../../shared/dashboard.ts";
import { addDays, assertDate, type DatePeriod } from "../../database/business-dates.ts";
import { getTestOeeSqlExpressions, getTestOeeDutCtes } from "../../skills/test-oee-calculator/assets/test-oee-calculator.ts";
import { periodLabel } from "./periods.ts";
import { createMachineExtremesTemplate } from "./template.ts";

interface MachineOee {
  readonly machine: string;
  readonly kind: string;
  readonly oee: number | null;
  readonly availabilityDays: number;
  readonly dutDays: number;
}

function queryMachines(database: DatabaseSync, period: DatePeriod): MachineOee[] {
  const a = getTestOeeSqlExpressions("availability", period.start, period.end, "a");
  const rows = database.prepare(`WITH
availability_classified AS (
  SELECT ${a.dayExpression} AS day, ${a.machineExpression} AS machine,
    ${a.kindExpression} AS kind, ${a.availabilityStateExpression} AS state_group,
    CAST(a.time_span AS REAL) AS state_seconds
  FROM oee_availability AS a
  WHERE ${a.dateRangePredicate} AND ${a.platformPredicate}
),
availability_period AS (
  SELECT machine, COUNT(DISTINCT day) AS availability_days,
    CASE WHEN SUM(CASE WHEN kind='MT' THEN state_seconds ELSE 0 END) >=
      SUM(CASE WHEN kind='ST' THEN state_seconds ELSE 0 END) THEN 'MT' ELSE 'ST' END AS kind,
    SUM(CASE WHEN state_group='Machine_Running' THEN state_seconds ELSE 0 END)
      / NULLIF(SUM(state_seconds), 0) AS availability
  FROM availability_classified
  WHERE kind IN ('MT','ST')
  GROUP BY machine
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
  SELECT q.machine, COUNT(DISTINCT q.day) AS dut_days,
    SUM(q.input_quantity) / NULLIF(SUM(q.socket_quantity), 0) AS dut_on,
    SUM(q.yield_output_quantity) / NULLIF(SUM(q.yield_input_quantity), 0) AS final_yield,
    CASE WHEN COUNT(t.trimmed_mean_test_seconds) < COUNT(*) THEN NULL
      ELSE SUM(t.trimmed_mean_test_seconds * q.touchdown_count)
        / NULLIF(SUM(q.actual_test_seconds), 0) END AS test_time_performance
  FROM machine_dut_daily AS q
  LEFT JOIN duration_trimmed AS t ON t.day=q.day AND t.kind=q.kind
  GROUP BY q.machine
)
SELECT a.machine, a.kind, a.availability_days, COALESCE(d.dut_days, 0) AS dut_days,
  a.availability * d.dut_on * d.test_time_performance * d.final_yield * 100 AS oee
FROM availability_period AS a
LEFT JOIN dut_period AS d ON d.machine=a.machine
ORDER BY oee, a.machine`).all();
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
          `${index + 1}.${machine.machine}(${machine.kind} ${machine.oee!.toFixed(2)}%)`).join("、") : null,
      });
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
  return {
    ...createMachineExtremesTemplate(),
    subtitle: "与 OEE 极值明细逐项对应的机台 TOP10 list",
    data, warnings: [...warnings],
  };
}
