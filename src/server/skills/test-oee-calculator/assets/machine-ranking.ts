import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import type { MachineRow as DashboardRow, MachineDatePeriod as DatePeriod, RankingSnapshot as DataSnapshotDescriptor, TestOeeRuntime } from "./runtime.ts";
import { machinePeriodSql } from "./machine-metrics.ts";
import { machineLabel, machinePlatform, MACHINE_PLATFORM_VERSION } from "./machine-platforms.ts";
import { getMachineDailyTestOeeSql, getTestOeeSqlExpressions } from "./test-oee-calculator.ts";

export const RANK_MACHINES_LOCAL_TOOL_NAME = "rank_machines";
export const RANK_MACHINES_TOOL_NAME = "test_oee_calculator__rank_machines";
export const MACHINE_METRICS = ["loss_hours", "availability", "effective_availability", "dut_on", "test_time_performance", "final_yield", "oee", "effective_oee"] as const;
export type MachineMetric = typeof MACHINE_METRICS[number];
export const rankMachinesParameters = Type.Object({
  start_date: Type.String({ description: "First included business-day label, YYYY-MM-DD." }),
  end_date: Type.String({ description: "Last included business-day label, YYYY-MM-DD." }),
  kind: Type.Union([Type.Literal("MT"), Type.Literal("ST")]),
  metric: Type.Union([Type.Literal("loss_hours"), Type.Literal("availability"), Type.Literal("effective_availability"),
    Type.Literal("dut_on"), Type.Literal("test_time_performance"), Type.Literal("final_yield"), Type.Literal("oee"), Type.Literal("effective_oee")]),
  states: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 100 }), { maxItems: 40,
    description: "Canonical loss states; only valid for loss_hours. Omit for all non-running states." })),
  basis: Type.Optional(Type.Union([Type.Literal("report_period"), Type.Literal("machine_day")], {
    description: "Default report_period: full-period ratios and daily type-wide 0.2% Test Time standard. machine_day: one day only, machine/type 1% standard with Test Time capped at 100%. Never mix bases." })),
}, { additionalProperties: false });

export interface MachineRankingScope {
  readonly kind: "MT" | "ST";
  readonly metric: MachineMetric;
  readonly states: readonly string[];
  readonly basis: "report_period" | "machine_day";
  readonly platformVersion: string;
}
export interface MachineRankingMeasurement {
  readonly range: DatePeriod;
  readonly scope: MachineRankingScope;
  readonly sql: string;
  readonly parameters: readonly (string | number | boolean | null)[];
  /** Complete candidates, including NULL values; labels are frozen with the evidence. */
  readonly rows: readonly DashboardRow[];
  readonly snapshot: DataSnapshotDescriptor;
  readonly truncated: false;
}
interface RankingSource {
  readonly sql: string;
  readonly rows: readonly DashboardRow[];
}
/** Use only for one frozen daily analysis transaction, never across interactive turns. */
export type MachineRankingCache = Map<string, RankingSource>;

const metricNames: Record<MachineMetric, string> = {
  loss_hours: "损失", availability: "可用率", effective_availability: "有效可用率", dut_on: "Socket 使用率",
  test_time_performance: "测试时间效率", final_yield: "良率", oee: "OEE", effective_oee: "Effective OEE",
};
const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);

export function machineRankingView(record: Pick<MachineRankingMeasurement, "rows" | "range" | "scope">) {
  const loss = record.scope.metric === "loss_hours";
  const candidates = record.rows.map((row, row_index) => ({ row, row_index }))
    .filter((entry) => finite(entry.row["metric_value"]))
    .sort((a, b) => (loss ? -1 : 1) * (Number(a.row["metric_value"]) - Number(b.row["metric_value"])) ||
      (String(a.row["machine"]) < String(b.row["machine"]) ? -1 : String(a.row["machine"]) > String(b.row["machine"]) ? 1 : 0));
  const total = loss && candidates.length && candidates.length === record.rows.length
    ? candidates.reduce((sum, entry) => sum + Number(entry.row["metric_value"]), 0) : null;
  const sharesValid = total !== null && finite(total) && total > 0 && candidates.every((entry) => Number(entry.row["metric_value"]) >= 0);
  const top3 = candidates.slice(0, 3).map(({ row, row_index }, index) => ({
    rank: index + 1, row_index, machine: String(row["machine"]), platform: row["platform"] ?? null,
    machine_label: String(row["machine_label"]), value: Number(row["metric_value"]),
    share_percent: sharesValid ? Number(row["metric_value"]) / total! * 100 : null,
    availability_days: row["availability_days"] ?? null, dut_days: row["dut_days"] ?? null,
    selected_days: row["selected_days"] ?? null,
  }));
  const top3Share = sharesValid ? top3.reduce((sum, entry) => sum + entry.value, 0) / total! * 100 : null;
  const missingPlatforms = record.rows.filter((row) => row["platform"] === null).map((row) => String(row["machine"]));
  const label = metricNames[record.scope.metric] + (loss && record.scope.states.length ? "（" + record.scope.states.join("、") + "）" : "");
  const coverage = (entry: typeof top3[number]): string => {
    const available = typeof entry.availability_days === "number" ? "，状态数据覆盖 " + entry.availability_days + "/" + entry.selected_days + " 天" : "";
    const dut = !loss && typeof entry.dut_days === "number" ? "，DUT 数据覆盖 " + entry.dut_days + "/" + entry.selected_days + " 天" : "";
    return available + dut;
  };
  const summary = record.scope.kind + " " + record.range.start + " 至 " + record.range.end + " " + label + "：" +
    (top3.length ? "TOP3（实际 " + top3.length + " 台，可计算 " + candidates.length + "/" + record.rows.length + " 台）" +
      top3.map((entry) => entry.machine_label + " " + entry.value.toFixed(loss ? 1 : 2) + (loss ? " 小时" : "%") +
        (entry.share_percent === null ? "" : "（占该项损失 " + entry.share_percent.toFixed(1) + "%）") + coverage(entry)).join("、") +
      (top3Share === null ? "" : "；TOP3 合计占该项损失 " + top3Share.toFixed(1) + "%") :
      "机台数据不足，无法生成 TOP3；无匹配记录不代表零损失或完整覆盖") +
    (["test_time_performance", "oee", "effective_oee"].includes(record.scope.metric)
      ? record.scope.basis === "machine_day" ? "；机台天口径（Test Time 1% 截尾、上限 100%）" : "；整期机台口径（Test Time 使用同日同类型 0.2% 截尾标准）"
      : record.scope.basis === "machine_day" ? "；单业务日机台统计" : "；整期机台汇总") +
    (missingPlatforms.length ? "；平台映射待维护 " + missingPlatforms.length + " 台" : "");
  return { top3, machine_count: candidates.length, observed_machine_count: record.rows.length,
    total_loss_hours: finite(total) ? total : null, top3_share_percent: top3Share,
    missing_platforms: missingPlatforms, summary };
}

export function machineLossSummaries(record: { readonly rows: readonly DashboardRow[]; readonly range: DatePeriod; readonly scope: { readonly byMachine: boolean; readonly states: readonly string[] } }) {
  if (!record.scope.byMachine) return [];
  return (["MT", "ST"] as const).map((kind) => {
    const grouped = new Map<string, DashboardRow[]>();
    for (const row of record.rows.filter((row) => row["kind"] === kind)) {
      if (typeof row["machine"] !== "string") continue;
      const rows = grouped.get(row["machine"]) ?? [];
      rows.push(row); grouped.set(row["machine"], rows);
    }
    const rows = [...grouped].map(([machine, entries]) => ({ machine, kind,
      platform: machinePlatform(machine), machine_label: machineLabel(machine), metric_value: entries.some((entry) => !finite(entry["loss_hours"])) ? null :
        entries.reduce((total, entry) => total + Number(entry["loss_hours"]), 0),
      availability_days: null, dut_days: null, selected_days: entries[0]?.["selected_days"] ?? null }));
    return { kind, ...machineRankingView({ rows, range: record.range,
      scope: { kind, metric: "loss_hours", states: record.scope.states, basis: "report_period", platformVersion: MACHINE_PLATFORM_VERSION } }) };
  });
}

export function rankMachines(
  runtime: TestOeeRuntime,
  params: Static<typeof rankMachinesParameters>, signal?: AbortSignal, cache?: MachineRankingCache,
): MachineRankingMeasurement {
  signal?.throwIfAborted();
  if (!Value.Check(rankMachinesParameters, params)) throw new Error("机台排名参数无效");
  // Reuse the Skill's date validation, including cached requests.
  getTestOeeSqlExpressions("availability", params.start_date, params.end_date);
  if (params.start_date > params.end_date) throw new Error("机台排名开始日期不能晚于结束日期");
  const range = { start: params.start_date, end: params.end_date };
  const scope: MachineRankingScope = { kind: params.kind, metric: params.metric, states: [...new Set(params.states ?? [])].sort(),
    basis: params.basis ?? "report_period", platformVersion: MACHINE_PLATFORM_VERSION };
  if (scope.metric !== "loss_hours" && scope.states.length) throw new Error("states 仅适用于损失小时排名");
  if (scope.basis === "machine_day" && range.start !== range.end) throw new Error("机台天口径必须查询同一业务日");
  const loss = scope.metric === "loss_hours";
  const key = JSON.stringify([range, loss ? "loss" : scope.basis]);
  let source = cache?.get(key);
  if (!source) {
    let sql: string;
    if (loss) {
      const e = getTestOeeSqlExpressions("availability", range.start, range.end, "a");
      sql = `WITH facts AS (
        SELECT ${e.dayExpression} AS day, ${e.machineExpression} AS machine, ${e.kindExpression} AS kind,
          ${e.availabilityStateExpression} AS state_group, CAST(a.time_span AS REAL) AS seconds
        FROM oee_availability a
        WHERE ${e.dateRangePredicate} AND ${e.sourceLotPredicate} AND ${e.platformPredicate}
      ), coverage AS (
        SELECT machine, kind, COUNT(DISTINCT day) AS availability_days FROM facts
        WHERE kind IN ('MT','ST') GROUP BY machine, kind
      ) SELECT f.machine, f.kind, f.state_group, SUM(f.seconds)/3600.0 AS loss_hours, c.availability_days
      FROM facts f JOIN coverage c USING(machine,kind)
      WHERE f.kind IN ('MT','ST') AND f.state_group<>'Machine_Running'
      GROUP BY f.machine, f.kind, f.state_group ORDER BY f.kind, f.machine, f.state_group`;
    } else if (scope.basis === "machine_day") {
      const daily = getMachineDailyTestOeeSql(range.start, range.end).sql;
      sql = `SELECT machine, kind, 1 AS availability_days, CASE WHEN dut_rows>0 THEN 1 ELSE 0 END AS dut_days,
        availability*100 AS availability, effective_availability*100 AS effective_availability,
        dut_on*100 AS dut_on, test_time_performance*100 AS test_time_performance,
        final_yield*100 AS final_yield, daily_test_oee*100 AS oee, daily_effective_oee*100 AS effective_oee
        FROM (${daily})`;
    } else sql = machinePeriodSql(range, true);
    const data = runtime.querySnapshot("rank-source-" + range.start.replaceAll("-", "") + "-" + range.end.replaceAll("-", ""), sql, signal);
    if (data.truncated) throw new Error("机台排名源数据超过快照上限，请缩小日期范围");
    source = { sql, rows: data.rows };
    cache?.set(key, source);
  }
  const selectedDays = (Date.parse(range.end) - Date.parse(range.start)) / 86_400_000 + 1;
  const selected = source.rows.filter((row) => row["kind"] === scope.kind &&
    (!loss || !scope.states.length || scope.states.includes(String(row["state_group"]))));
  const machines = new Map<string, DashboardRow>();
  for (const row of selected) {
    signal?.throwIfAborted();
    const machine = String(row["machine"]);
    const previous = machines.get(machine);
    const value = loss ? row["loss_hours"] : row[scope.metric];
    if (value !== null && !finite(value)) throw new Error("机台排名源指标不是有限数值");
    const metricValue = loss && previous ? (finite(previous["metric_value"]) && finite(value) ? previous["metric_value"] + value : null) : value;
    machines.set(machine, { machine, kind: scope.kind, platform: machinePlatform(machine), machine_label: machineLabel(machine),
      metric_value: metricValue ?? null, availability_days: row["availability_days"] ?? null,
      dut_days: row["dut_days"] ?? null, selected_days: selectedDays });
  }
  const rows = [...machines.values()].sort((a, b) => String(a["machine"]) < String(b["machine"]) ? -1 : 1);
  const columns = ["machine", "kind", "platform", "machine_label", "metric_value", "availability_days", "dut_days", "selected_days"];
  signal?.throwIfAborted();
  const snapshot = runtime.saveSnapshot("rank-" + range.start.replaceAll("-", "") + "-" + range.end.replaceAll("-", "") + "-" + scope.metric,
    { columns, rows, rowCount: rows.length, truncated: false, range, scope }, signal);
  return { range, scope, sql: source.sql, parameters: [], rows, snapshot, truncated: false };
}

export function createRankMachinesTool(
  runtime?: TestOeeRuntime,
  recordEvidence?: (measurement: MachineRankingMeasurement) => string, cache?: MachineRankingCache,
) {
  return defineTool({
    name: RANK_MACHINES_LOCAL_TOOL_NAME, label: "查询问题指标机台 TOP3", executionMode: "sequential",
    description: "Compute deterministic TOP3 for one business-day range and MT/ST type. loss_hours aggregates selected canonical states per distinct machine, descending; other metrics rank ascending. Shares use ALL machines in the identical loss scope, not only TOP3. Complete immutable candidate snapshots include raw machine IDs, platform labels, values and source coverage. Ratio value/metric_value are percentage points (50 means 50%), never multiply by 100 again; loss values are hours. NULL metrics are excluded, ties use unrounded values then machine ID. Missing platforms remain visible as 平台待维护. report_period preserves the fleet-standard full-period formula; machine_day requires one day and preserves 1% machine/type trim and Test Time cap. Read the Test OEE Skill first. Copy summary verbatim in business problem analyses. Evidence is derived and cannot supply loss_reference. Empty results do not prove zero loss or complete coverage.",
    parameters: rankMachinesParameters,
    async execute(_id, params, signal) {
      signal?.throwIfAborted();
      if (!runtime) throw new Error("OEE Skill 排名工具缺少会话运行依赖");
      const measurement = rankMachines(runtime, params, signal, cache);
      const evidenceId = recordEvidence?.(measurement);
      const details = { ...(evidenceId ? { evidence_id: evidenceId } : {}), range: measurement.range, scope: measurement.scope,
        snapshot: measurement.snapshot, truncated: false, ...machineRankingView(measurement) };
      return { content: [{ type: "text" as const, text: JSON.stringify(details) }], details };
    },
  });
}
