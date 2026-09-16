import type { DatabaseSync } from "node:sqlite";
import type { DashboardRow, DashboardTableWidget } from "../../../shared/dashboard.ts";
import { addDays, assertDate, type DatePeriod } from "../../database/business-dates.ts";
import { getTestOeeSqlExpressions, TEST_OEE_DAY_SECONDS } from "../../skills/test-oee-calculator/assets/test-oee-calculator.ts";
import { periodLabel } from "./periods.ts";

interface MachineOee {
  readonly machine: string;
  readonly kind: string;
  readonly oee: number | null;
  readonly availabilityDays: number;
  readonly dutDays: number;
}

function queryMachines(database: DatabaseSync, period: DatePeriod): MachineOee[] {
  const a = getTestOeeSqlExpressions("availability", period.start, period.end, "a");
  const d = getTestOeeSqlExpressions("dut", period.start, period.end, "d");
  const rows = database.prepare(`WITH
availability_classified AS (
  SELECT ${a.dayExpression} AS day, ${a.machineExpression} AS machine,
    ${a.kindExpression} AS kind, ${a.availabilityStateExpression} AS state_group,
    CAST(a.time_span AS REAL) AS state_seconds
  FROM oee_availability AS a
  WHERE ${a.dateRangePredicate} AND ${a.lotPredicate} AND ${a.platformPredicate}
),
availability_period AS (
  SELECT machine, COUNT(DISTINCT day) AS availability_days,
    CASE WHEN SUM(CASE WHEN kind='MT' THEN state_seconds ELSE 0 END) >=
      SUM(CASE WHEN kind='ST' THEN state_seconds ELSE 0 END) THEN 'MT' ELSE 'ST' END AS kind,
    SUM(CASE WHEN state_group='Machine_Running' THEN state_seconds ELSE 0 END)
      / NULLIF(COUNT(DISTINCT day) * ${TEST_OEE_DAY_SECONDS}.0, 0) AS availability
  FROM availability_classified
  WHERE kind IN ('MT','ST')
  GROUP BY machine
),
dut_classified AS (
  SELECT ${d.dayExpression} AS day, ${d.machineExpression} AS machine,
    ${d.kindExpression} AS kind,
    CAST(NULLIF(trim(d.in_qty),'') AS REAL) AS input_quantity,
    CAST(NULLIF(trim(d.out_qty),'') AS REAL) AS output_quantity,
    CAST(NULLIF(trim(d.dut_num),'') AS REAL) AS socket_quantity
  FROM oee_dut_utilization AS d
  WHERE ${d.dateRangePredicate} AND ${d.lotPredicate} AND ${d.platformPredicate}
),
dut_period AS (
  SELECT machine, COUNT(DISTINCT day) AS dut_days,
    SUM(input_quantity) / NULLIF(SUM(socket_quantity), 0) AS performance,
    SUM(output_quantity) / NULLIF(SUM(input_quantity), 0) AS final_yield
  FROM dut_classified
  WHERE kind IN ('MT','ST')
  GROUP BY machine
)
SELECT a.machine, a.kind, a.availability_days, COALESCE(d.dut_days, 0) AS dut_days,
  a.availability * d.performance * d.final_yield * 100 AS oee
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
    id: "mt-st-components-2026", kind: "table", size: "wide",
    title: "OEE 机台 TOP10（周/月/季）· 极值单项对应",
    subtitle: "与 OEE 极值明细逐项对应的机台 TOP10 list",
    data,
    encoding: { columns: [
      { key: "grain", label: "粒度" },
      { key: "point_type", label: "极值" },
      { key: "period_label", label: "周期" },
      { key: "oee_percent", label: "周期OEE%" },
      { key: "top10_machines", label: "TOP10 机台（机台 OEE 最低）" },
    ] },
    format: { unit: "%", precision: 2 },
    metricDefinition: "与 OEE 极值明细（周/月/季）逐项对应；周期 OEE 沿用日类型等权平均。机台 OEE 按同一周期整期汇总：运行秒数÷（有效 Availability 业务日数×86400）×SUM(IN_QTY)÷SUM(DUT_NUM)×SUM(OUT_QTY)÷SUM(IN_QTY)×100；MT/ST 合并为一台，按 Availability 累计时长标注主要类型，并列取 MT。按未舍入机台 OEE 升序取最低 10 台，并列按机台编号；不足 10 台展示实际数量。年初首周及截至业务日的未完整月、季按实际范围统计，缺日不会补零。",
    warnings: [...warnings],
  };
}
