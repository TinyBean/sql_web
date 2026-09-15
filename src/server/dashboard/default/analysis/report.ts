import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import { parseDashboardState, type DashboardRow, type DashboardState } from "../../../../shared/dashboard.ts";
import { PERIOD_KEYS, type AnalysisContext, type Evidence, type PeriodKey } from "./evidence.ts";

const text = Type.String({ minLength: 1, maxLength: 1800 });
const refs = Type.Array(Type.String({ minLength: 1 }), { minItems: 1, maxItems: 12 });
export const PeriodKeySchema = Type.Union([Type.Literal("week"), Type.Literal("month"), Type.Literal("quarter")]);
export const AnalysisReportSchema = Type.Object({
  verification: Type.Optional(Type.String({ minLength: 1, maxLength: 5000 })),
  periods: Type.Array(Type.Object({
    period: PeriodKeySchema,
    comparison: text,
    minimum_evidence: Type.String(),
    history_evidence: Type.String(),
    groups: Type.Array(Type.Object({
      kind: Type.Union([Type.Literal("MT"), Type.Literal("ST")]),
      no_findings_reason: Type.String({ maxLength: 1800 }),
      evidence_ids: refs,
      items: Type.Array(Type.Object({
        priority: Type.Integer({ minimum: 1, maximum: 3 }),
        category: Type.Union([Type.Literal("availability"), Type.Literal("performance"), Type.Literal("yield"), Type.Literal("other")]),
        issue: text,
        measure: text,
        suggested_owner: Type.String({ minLength: 1, maxLength: 160 }),
        evidence_ids: refs,
        loss_reference: Type.Union([Type.Null(), Type.Object({ evidence_id: Type.String(), row_index: Type.Integer({ minimum: 0 }) }, { additionalProperties: false })]),
      }, { additionalProperties: false }), { maxItems: 3 }),
    }, { additionalProperties: false }), { minItems: 2, maxItems: 2 }),
  }, { additionalProperties: false }), { minItems: 3, maxItems: 3 }),
}, { additionalProperties: false });

export type AnalysisReport = Static<typeof AnalysisReportSchema>;

export function validateAnalysisReport(
  value: unknown, context: AnalysisContext, evidence: ReadonlyMap<string, Evidence>,
): { report: AnalysisReport; rows: Record<PeriodKey, DashboardRow[]> } {
  if (!Value.Check(AnalysisReportSchema, value)) throw new Error("报告字段或结构无效，请按 submit_analysis 参数结构提交完整三期、每期 MT/ST 两组");
  const rows = {} as Record<PeriodKey, DashboardRow[]>;
  const checkRefs = (ids: readonly string[]): void => {
    for (const id of ids) {
      const result = evidence.get(id);
      if (!result || result.truncated) throw new Error("证据不存在或被截断：" + id);
    }
  };
  for (const key of PERIOD_KEYS) {
    const reports = value.periods.filter((report) => report.period === key);
    if (reports.length !== 1) throw new Error("每个周期必须且只能提交一次：" + key);
    const report = reports[0]!;
    const expected = context.comparisons[key];
    if (report.minimum_evidence !== expected.minimum.id || report.history_evidence !== expected.history.id) {
      throw new Error(key + " 的最低点或历史证据引用不匹配初始上下文");
    }
    checkRefs([report.minimum_evidence, report.history_evidence]);
    rows[key] = [];
    for (const kind of ["MT", "ST"] as const) {
      const groups = report.groups.filter((group) => group.kind === kind);
      if (groups.length !== 1) throw new Error(key + " 必须分别覆盖 MT 和 ST");
      const group = groups[0]!;
      checkRefs(group.evidence_ids);
      if (!group.evidence_ids.includes(expected.current.id)) throw new Error(key + "/" + kind + " 缺少本期指标证据");
      if (!group.items.length && !group.no_findings_reason.trim()) throw new Error("空清单必须解释数据不足或无充分依据的原因");
      const items = [...group.items].sort((a, b) => a.priority - b.priority);
      for (const [index, item] of items.entries()) {
        if (item.priority !== index + 1) throw new Error("同周期同类型优先级必须由 1 连续排列且不重复");
        if (![item.issue, item.measure, item.suggested_owner].every((field) => field.trim())) throw new Error("问题、措施、责任职能不能为空");
        checkRefs(item.evidence_ids);
        let hours: number | null = null;
        if (item.loss_reference !== null) {
          if (item.category === "performance" || item.category === "yield") throw new Error("Performance/Yield 不得折算为损失小时，loss_reference 应为 null");
          const ref = item.loss_reference;
          checkRefs([ref.evidence_id]);
          const measured = evidence.get(ref.evidence_id)!;
          const row = measured.rows[ref.row_index];
          if (!item.evidence_ids.includes(ref.evidence_id) || measured.lossPeriod !== key ||
              measured.range?.start !== context.periods[key].start || measured.range.end !== context.periods[key].end ||
              row?.["kind"] !== kind || typeof row["loss_hours"] !== "number") {
            throw new Error("损失小时必须引用 measure_loss 返回的本期同类型实测行");
          }
          hours = Math.round(row["loss_hours"] * 10) / 10;
        }
        rows[key].push({
          kind, priority: item.priority, issue: item.issue, measure: item.measure,
          suggested_owner: item.suggested_owner + "（职能建议，待人工确认）", loss_hours: hours,
        });
      }
    }
  }
  return { report: value, rows };
}

export function applyAnalysisReport(
  state: DashboardState, result: ReturnType<typeof validateAnalysisReport>,
): DashboardState {
  return parseDashboardState({ ...state, widgets: state.widgets.map((widget) => {
    const key = PERIOD_KEYS.find((key) => widget.id === "improvement-actions-" + key + "-2026");
    if (!key) return widget;
    const report = result.report.periods.find((period) => period.period === key)!;
    return {
      ...widget, data: result.rows[key],
      warnings: [
        ...widget.warnings.filter((warning) => !warning.startsWith("本次分析暂不可用")),
        ...report.groups.filter((group) => !group.items.length).map((group) =>
          (group.kind + " 未生成建议：" + group.no_findings_reason).slice(0, 300)),
      ],
    };
  }) });
}

export function analysisUnavailable(state: DashboardState, reason: string): DashboardState {
  return parseDashboardState({ ...state, widgets: state.widgets.map((widget) => {
    if (!widget.id.startsWith("improvement-actions-")) return widget;
    return {
      ...widget, data: [], warnings: [
        ...widget.warnings.filter((warning) => !warning.startsWith("本次分析暂不可用")),
        ("本次分析暂不可用：" + reason).slice(0, 300),
      ],
    };
  }) });
}
