import type { DashboardRow } from "../../shared/dashboard.ts";
import type { LossResult } from "./loss-tools.ts";

export const LOSS_VIEW_BYTES = 12 * 1024;
const byteLength = (value: unknown): number => Buffer.byteLength(JSON.stringify(value));
const lexical = (a: unknown, b: unknown): number => String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0;
const sum = (rows: readonly DashboardRow[]): number | null => {
  if (!rows.length || rows.some((row) => typeof row["loss_hours"] !== "number")) return null;
  const value = rows.reduce((total, row) => total + Number(row["loss_hours"]), 0);
  return Number.isFinite(value) ? value : null;
};
const denominator = (rows: readonly DashboardRow[], key: string): number | null => {
  const value = rows[0]?.[key];
  return typeof value === "number" && value > 0 && Number.isFinite(value) && rows.every((row) => row[key] === value) ? value : null;
};

/** Derived totals never gain row indices. Only original rows can supply display hours. */
export function lossView(record: LossResult) {
  const indexed = record.rows.map((row, row_index) => ({ row_index, row }));
  if (record.truncated) return { mode: "unavailable" as const, rows_complete: false,
    reason: "原始证据被截断，不能生成全量统计或用于报告；请缩小查询范围" };
  const complete = { mode: "complete" as const, rows_complete: true, note: "空结果仅表示没有匹配损失行，不能推断数据覆盖完整或损失为零。", rows: indexed };
  if (indexed.length <= 32 && byteLength(complete) <= LOSS_VIEW_BYTES) return complete;
  const byKind = ["MT", "ST"].map((kind) => {
    const entries = indexed.filter((entry) => entry.row["kind"] === kind);
    const rows = entries.map((entry) => entry.row);
    const total = sum(rows);
    const availabilityDays = denominator(rows, "kind_availability_days");
    const selectedDays = denominator(rows, "selected_days");
    const validShare = total !== null && total > 0 && rows.every((row) => Number(row["loss_hours"]) >= 0);
    const states = [...new Set(rows.map((row) => String(row["state_group"])))].sort();
    const stateTotals = states.map((state) => {
      const hours = sum(rows.filter((row) => row["state_group"] === state));
      return { state_group: state, loss_hours: hours,
        share_percent: validShare && hours !== null ? hours / total! * 100 : null,
        hours_per_kind_available_day: hours !== null && availabilityDays ? hours / availabilityDays : null,
        hours_per_selected_day: hours !== null && selectedDays ? hours / selectedDays : null };
    }).sort((a, b) => (b.loss_hours ?? -Infinity) - (a.loss_hours ?? -Infinity) || lexical(a.state_group, b.state_group));
    const ranked = entries.filter((entry) => typeof entry.row["loss_hours"] === "number")
      .sort((a, b) => Number(b.row["loss_hours"]) - Number(a.row["loss_hours"]) ||
        lexical(a.row["machine"] ?? "", b.row["machine"] ?? "") || lexical(a.row["state_group"], b.row["state_group"]));
    return { kind, row_count: rows.length, loss_hours: total,
      kind_availability_days: availabilityDays, selected_days: selectedDays,
      state_count: states.length, state_totals: stateTotals, ranking: ranked.slice(0, 10) };
  });
  const summary = { mode: "summary" as const, rows_complete: false, totals_from_complete_evidence: true,
    state_summaries_complete: true, rankings_complete: false, by_kind: byKind,
    note: "合计与占比为当前筛选范围的派生统计，不是 loss_reference；ranking 的 row_index 指向原始证据。覆盖天数不是机台天数之和；无损失记录不等于零损失。" };
  // Trim evenly by rank, never accidentally give ST only the remainder of a shared row limit.
  while (byteLength(summary) > LOSS_VIEW_BYTES && byKind.some((group) => group.ranking.length)) {
    for (const group of byKind) group.ranking.pop();
  }
  while (byteLength(summary) > LOSS_VIEW_BYTES && byKind.some((group) => group.state_totals.length)) {
    summary.state_summaries_complete = false;
    for (const group of byKind) group.state_totals.pop();
  }
  summary.rankings_complete = byKind.every((group) => group.ranking.length === group.row_count);
  return summary;
}

export function lossOutput(record: LossResult, evidenceId?: string) {
  const details = { ...(evidenceId === undefined ? {} : { evidence_id: evidenceId }), range: record.range,
    scope: record.scope, snapshot: record.snapshot ?? null, row_count: record.rows.length,
    truncated: record.truncated, view: lossView(record),
    next_step: "complete 视图已含全部结果，summary 已含全量计算的合计和局部排名；可直接分析。额外调查才用 SQL/Python。需要更多明细时按 snapshot.name 读取，保留原始 row_index。" };
  return { content: [{ type: "text" as const, text: JSON.stringify(details) }], details };
}
