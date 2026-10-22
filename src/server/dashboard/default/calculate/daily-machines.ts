import type { DatabaseSync } from "node:sqlite";
import type { DashboardRow, DashboardTableWidget } from "../../../../shared/dashboard.ts";
import { formatDisplayNumber } from "../../../../shared/number-format.ts";
import { machinePeriodSql } from "../../../skills/test-oee-calculator/assets/machine-metrics.ts";
import { getTestOeeSqlExpressions } from "../../../skills/test-oee-calculator/assets/test-oee-calculator.ts";
import { machineLabel } from "../../../skills/test-oee-calculator/assets/machine-platforms.ts";
import { createMachineAnalysisTemplate, MACHINE_KINDS, MACHINE_RANKINGS,
  type MachineKind, type MachineRanking } from "../template.ts";

export const MACHINE_ADVICE_UNAVAILABLE = "改善建议暂不可用";

/** Full metric candidates and all observed loss states use the same Skill filters. */
export function dailyMachineSql(day: string, kind?: MachineKind): string {
  const range = { start: day, end: day };
  const e = getTestOeeSqlExpressions("availability", day, day, "a");
  return `WITH metrics AS (${machinePeriodSql(range, true)}), facts AS (
    SELECT ${e.machineExpression} AS machine, ${e.kindExpression} AS kind,
      ${e.availabilityStateExpression} AS state_group, CAST(a.time_span AS REAL) AS seconds
    FROM oee_availability a
    WHERE ${e.dateRangePredicate} AND ${e.sourceLotPredicate} AND ${e.platformPredicate}
  ), losses AS (
    SELECT machine, kind, state_group, SUM(seconds)/3600.0 AS loss_hours
    FROM facts WHERE kind IN ('MT','ST') AND state_group<>'Machine_Running'
    GROUP BY machine, kind, state_group
  ), ranked_losses AS (
    SELECT *, ROW_NUMBER() OVER (PARTITION BY machine, kind ORDER BY loss_hours DESC, state_group) AS position
    FROM losses
  ) SELECT '${day}' AS day, m.*, l.state_group AS main_loss_state, l.loss_hours AS main_loss_hours,
    (SELECT json_group_array(json_object('state', state_group, 'loss_hours', loss_hours))
      FROM (SELECT state_group, loss_hours FROM losses all_losses
        WHERE all_losses.machine=m.machine AND all_losses.kind=m.kind ORDER BY loss_hours DESC, state_group)) AS loss_states
  FROM metrics m LEFT JOIN ranked_losses l ON l.machine=m.machine AND l.kind=m.kind AND l.position=1
  ${kind ? `WHERE m.kind='${kind}'` : ""} ORDER BY m.kind, m.machine`;
}

export function readDailyMachines(database: DatabaseSync, day: string): DashboardRow[] {
  return database.prepare(dailyMachineSql(day)).all().map((row) => Object.fromEntries(
    Object.entries(row).map(([key, value]) => {
      if (value === null || typeof value === "string" || typeof value === "number" && Number.isFinite(value)) return [key, value];
      throw new Error("机台日指标包含无效值:" + key);
    }),
  ));
}

export function selectDailyMachines(rows: readonly DashboardRow[], kind: MachineKind, ranking: MachineRanking) {
  return rows.map((row, row_index) => ({ row, row_index }))
    .filter(({ row }) => row["kind"] === kind && typeof row["oee"] === "number" && Number.isFinite(row["oee"]))
    .sort((a, b) => (ranking === "best" ? -1 : 1) * (Number(a.row["oee"]) - Number(b.row["oee"])) ||
      (String(a.row["machine"]) < String(b.row["machine"]) ? -1 : String(a.row["machine"]) > String(b.row["machine"]) ? 1 : 0))
    .slice(0, 10).map((entry, index) => ({ ...entry, rank: index + 1 }));
}

export function machineLossAndBottleneck(row: DashboardRow): string {
  const loss = typeof row["main_loss_state"] === "string" && typeof row["main_loss_hours"] === "number"
    ? `${row["main_loss_state"]} ${formatDisplayNumber(row["main_loss_hours"])} 小时` : "未记录非运行损失(不代表零损失或完整覆盖)";
  const factors = [
    ["Availability", row["availability"]], ["Performance (DUT-On)", row["dut_on"]],
    ["Performance (Test Time)", row["test_time_performance"]], ["Yield", row["final_yield"]],
  ] as const;
  const values = factors.map(([, value]) => value).filter((value): value is number => typeof value === "number" && Number.isFinite(value));
  const minimum = values.length ? Math.min(...values) : null;
  const weakest = factors.filter(([, value]) => minimum !== null && value === minimum)
    .map(([name, value]) => `${name} ${formatDisplayNumber(Number(value))}%`).join("、");
  return `主损失:${loss}\n短板:${weakest || "子项数据不足"}`;
}

export function buildDailyMachineCards(rows: readonly DashboardRow[], day: string, warnings: readonly string[] = []): DashboardTableWidget[] {
  return MACHINE_KINDS.flatMap((kind) => MACHINE_RANKINGS.map((ranking) => {
    const template = createMachineAnalysisTemplate(kind, ranking);
    const selected = selectDailyMachines(rows, kind, ranking);
    const observed = rows.filter((row) => row["kind"] === kind).length;
    const calculable = rows.filter((row) => row["kind"] === kind && typeof row["oee"] === "number").length;
    return { ...template, title: `${template.title}(${day})`,
      subtitle: `业务日 ${day}(08:30 至次日 08:30)· 可计算 ${calculable}/${observed} 台`,
      data: selected.map(({ row, rank }) => ({ kind, rank, machine: row["machine"]!, machine_label: machineLabel(String(row["machine"])), oee: row["oee"]!,
        availability: row["availability"]!, dut_on: row["dut_on"]!, test_time_performance: row["test_time_performance"]!,
        final_yield: row["final_yield"]!, loss_and_bottleneck: machineLossAndBottleneck(row), action_and_owner: MACHINE_ADVICE_UNAVAILABLE })),
      warnings: [...warnings, ...(selected.length < 10 ? [`${kind} 可计算机台不足 10 台,实际展示 ${selected.length} 台;缺失不补零`] : []),
        MACHINE_ADVICE_UNAVAILABLE + ":尚未完成逐台分析", "责任人为职能建议,待人工确认"],
    };
  }));
}
