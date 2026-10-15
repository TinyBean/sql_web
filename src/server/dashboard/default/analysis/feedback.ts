import type { AnalysisContext, Evidence } from "./evidence.ts";
import type { AnalysisGroup, AnalysisReport, AnalysisValidationIssue } from "./report.ts";
import { ANALYSIS_PERIOD_KEYS, type PeriodKey } from "../periods.ts";

export interface RepairTarget { readonly period: PeriodKey; readonly kind: "MT" | "ST" }
export interface RepairAttempt { readonly tool: "submit_analysis" | "repair_analysis_group"; readonly target?: RepairTarget }
export interface RepairCorrection {
  readonly code: string;
  readonly path: string;
  readonly argument_path: string;
  readonly report_path?: string;
  readonly period?: PeriodKey;
  readonly kind?: "MT" | "ST";
  readonly item_index?: number;
  readonly priority?: number;
  readonly instruction: string;
  readonly replacement?: unknown;
  readonly choices?: readonly unknown[];
}
export interface EvidenceAction extends RepairTarget {
  readonly action: "reuse" | "query" | "investigate";
  readonly instruction: string;
  readonly item_index?: number;
  readonly evidence_ids?: readonly string[];
  readonly tool?: string;
  readonly arguments?: Readonly<Record<string, unknown>>;
}
export interface AnalysisRepairPlan {
  readonly submit_tool: RepairAttempt["tool"] | null;
  readonly instruction: string;
  readonly targets: readonly RepairTarget[];
  readonly corrections: readonly RepairCorrection[];
  readonly evidence_actions: readonly EvidenceAction[];
}

const record = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value)
  ? value as Record<string, unknown> : {};

/** Match every condition enforced on ranking references, including ownership and row kinds. */
function compatibleRanking(evidence: Evidence, context: AnalysisContext, target: RepairTarget, state: string): boolean {
  const scope = evidence.rankingScope;
  const range = context.periods[target.period];
  return !evidence.truncated && evidence.owner?.period === target.period && evidence.source === "rank_machines" &&
    evidence.range?.start === range.start && evidence.range.end === range.end && scope?.kind === target.kind &&
    evidence.rows.every((row) => row["kind"] === target.kind) && scope.basis === "report_period" &&
    scope.metric === "loss_hours" && scope.states.length === 1 && scope.states[0] === state;
}

export function pendingRepairTargets(candidate: AnalysisReport | undefined, issues: readonly AnalysisValidationIssue[]): RepairTarget[] {
  return candidate?.periods.flatMap((period) => period.groups.filter((group) =>
    issues.some((issue) => issue.period === period.period && issue.kind === group.kind))
    .map((group) => ({ period: period.period, kind: group.kind }))) ?? [];
}

/** A single plan drives tool feedback, dynamic context and permission to acquire more evidence. */
export function analysisRepairPlan(
  context: AnalysisContext, evidence: ReadonlyMap<string, Evidence>, candidate: AnalysisReport | undefined,
  issues: readonly AnalysisValidationIssue[], candidateIssues: readonly AnalysisValidationIssue[],
  attempt: RepairAttempt, stopped: boolean,
): AnalysisRepairPlan {
  const targets = pendingRepairTargets(candidate, candidateIssues);
  const reportErrors = candidateIssues.some((issue) => !issue.kind || ["PERIOD_COVERAGE", "KIND_COVERAGE", "BASELINE_MISMATCH"].includes(issue.code));
  const malformedReport = attempt.tool === "submit_analysis" && issues.some((issue) => issue.code === "STRUCTURE_INVALID");
  const submitTool = stopped || !issues.length ? null : !candidate || reportErrors || malformedReport || !targets.length
    ? "submit_analysis" : "repair_analysis_group";
  const corrections: RepairCorrection[] = [];
  const actions: EvidenceAction[] = [];
  const addAction = (action: EvidenceAction): void => {
    if (!actions.some((entry) => JSON.stringify(entry) === JSON.stringify(action))) actions.push(action);
  };
  // A malformed patch or wrong target must not hide the saved candidate's unresolved evidence failures.
  const diagnostics = attempt.tool === "repair_analysis_group"
    ? [...issues, ...candidateIssues.filter((entry) => !issues.some((issue) => issue.code === entry.code && issue.path === entry.path))] : issues;
  for (const issue of diagnostics) {
    const target = issue.period && issue.kind ? { period: issue.period, kind: issue.kind } : attempt.target;
    const periodIndex = candidate?.periods.findIndex((entry) => entry.period === target?.period) ?? -1;
    const period = candidate?.periods[periodIndex];
    const groupIndex = period?.groups.findIndex((entry) => entry.kind === target?.kind) ?? -1;
    const group = period?.groups[groupIndex];
    const groupPath = periodIndex >= 0 && groupIndex >= 0 ? `/periods/${periodIndex}/groups/${groupIndex}` : undefined;
    const invalidTarget = issue.code === "REPAIR_TARGET_INVALID";
    const groupInput = (issue.code === "STRUCTURE_INVALID" || invalidTarget) && attempt.tool === "repair_analysis_group";
    const targetAllowed = targets.some((entry) => entry.period === target?.period && entry.kind === target?.kind);
    let reportPath = groupInput ? groupPath && (!invalidTarget || targetAllowed) && /^\/group(?:\/|$)/u.test(issue.path)
      ? groupPath + issue.path.slice("/group".length) : undefined : issue.path;
    let argumentPath = submitTool === "repair_analysis_group" && groupPath && reportPath?.startsWith(groupPath + "/")
      ? "/group" + reportPath.slice(groupPath.length) : groupInput ? issue.path : reportPath ?? issue.path;
    let instruction = issue.hint;
    let replacement: unknown;
    let choices: readonly unknown[] | undefined;
    const expected = record(issue.expected);
    if (issue.code === "STRUCTURE_INVALID") {
      if (Object.hasOwn(expected, "const")) replacement = expected["const"];
      if (Array.isArray(expected["enum"])) choices = expected["enum"];
      if (issue.path.startsWith("/omitted_candidates")) instruction += " omitted_candidates 为可选字段;可省略此审计字段,填写时其中 item 也必须满足完整建议 Schema。";
    } else if (issue.code === "BASELINE_MISMATCH") {
      replacement = issue.expected;
      instruction = "将该字段替换为 replacement 指定的本次运行基准编号,并完整重提四期报告。";
    } else if (issue.code === "PERIOD_COVERAGE") {
      choices = ANALYSIS_PERIOD_KEYS;
      instruction = `完整提交四期报告；${issue.period} 当前出现 ${issue.actual} 次，必须恰好一次。periods 必须包含 choices 各一次，保留已核实的其他周期内容。`;
    } else if (issue.code === "KIND_COVERAGE") {
      choices = ["MT", "ST"];
      instruction = `${issue.period} 的 groups 必须包含 MT、ST 各一组，${issue.kind} 当前出现 ${issue.actual} 次；修正分组后完整重提。`;
    } else if (target) {
      const selection = context.losses[target.period];
      const item: AnalysisGroup["items"][number] | undefined = issue.item_index === undefined ? undefined : group?.items[issue.item_index];
      const selected = item && item.loss_reference.evidence_id === selection.evidence_id
        ? selection.by_kind[target.kind].find((entry) => entry.row_index === item.loss_reference.row_index) : undefined;
      const rankingProblem = issue.path.includes("/machine_evidence_ids") || issue.code.startsWith("RANKING_") ||
        ["LOSS_STATE_MISMATCH", "METRIC_CATEGORY_MISMATCH"].includes(issue.code) ||
        (issue.evidence_id !== undefined && item?.machine_evidence_ids.includes(issue.evidence_id));
      const lossProblem = issue.code === "LOSS_REFERENCE_MISMATCH" || issue.path.includes("/loss_reference") ||
        (!rankingProblem && issue.evidence_id !== undefined && item?.loss_reference.evidence_id === issue.evidence_id);
      if (["CURRENT_EVIDENCE_MISSING", "CURRENT_LOSS_EVIDENCE_MISSING"].includes(issue.code)) {
        choices = [context.comparisons[target.period].current.id, selection.evidence_id];
        instruction = "将 choices 中的两个必需编号加入本组 evidence_ids,保留其他有效引用;总数不得超过 12。空建议组也需要这些引用。";
      } else if (lossProblem || (rankingProblem && !selected)) {
        choices = selection.by_kind[target.kind].map((entry) => ({ evidence_id: selection.evidence_id,
          row_index: entry.row_index, state_group: entry.state_group, loss_hours: entry.loss_hours }));
        instruction = "先从 choices 选择实际分析的损失状态,将其 evidence_id、原始 row_index 填入 loss_reference,并将证据编号加入建议 evidence_ids;多个候选不得按 priority 猜行号。";
        addAction({ ...target, action: "reuse", evidence_ids: [selection.evidence_id], instruction: "复用程序提供的完整损失汇总及合法入选行;修正损失引用后再确定对应状态的机台排名。" });
      } else if (rankingProblem && selected) {
        const compatible = [...evidence.values()].filter((entry) => compatibleRanking(entry, context, target, selected.state_group));
        if (compatible.length) {
          choices = compatible.map((entry) => entry.id);
          instruction = "从 choices 复用兼容的排名编号,修正 machine_evidence_ids,并同步加入建议 evidence_ids;不要仅新增正确编号却保留错误排名。其他有效排名和正文保持不变。";
          addAction({ ...target, action: "reuse", item_index: issue.item_index!, evidence_ids: compatible.map((entry) => entry.id),
            instruction: "已有同周期、同类型、同损失状态的完整 loss_hours 排名,无需补查。" });
        } else {
          const range = context.periods[target.period];
          instruction = "当前没有兼容排名;按 evidence_actions 补查后,将返回编号同时加入 machine_evidence_ids 与建议 evidence_ids。";
          addAction({ ...target, action: "query", item_index: issue.item_index!, tool: "test_oee_calculator__rank_machines",
            arguments: { period: target.period, start_date: range.start, end_date: range.end,
              kind: target.kind, metric: "loss_hours", states: [selected.state_group] },
            instruction: "若排名工具尚未启用,先读取 test-oee-calculator Skill;按 arguments 调用。basis 是返回元数据,不是调用参数。" });
        }
      } else if (issue.code.startsWith("EVIDENCE_")) {
        addAction({ ...target, action: "investigate", instruction: "先检查本周期证据目录,替换错误引用或移除不需要的额外引用;若确实缺少支持事实,再使用只读工具补查并填写本周期 period,不猜证据编号。" });
      }
    }
    if (issue.code === "REPAIR_TARGET_INVALID") instruction = submitTool === "submit_analysis"
      ? "当前没有可局部修正的合法候选,或存在组外错误;调用 submit_analysis,提交完整四期、各期 MT/ST 两组。"
      : "从 repair_plan.targets 选择待修组,使用 pending_groups 中的原组,只修改出错字段;period、kind 和 group.kind 必须一致。";
    if (invalidTarget && submitTool === "repair_analysis_group" && targetAllowed && target &&
        record(issue.actual)["group_kind"] !== target.kind) {
      argumentPath = "/group/kind";
      reportPath = groupPath + "/kind";
      replacement = target.kind;
      instruction = "将 group.kind 改为 replacement，与调用参数 kind 一致；其余内容按 pending_groups 中的目标组修正。";
    }
    corrections.push({ code: issue.code, path: issue.path, argument_path: argumentPath,
      ...(reportPath ? { report_path: reportPath } : {}), instruction,
      ...(issue.period ? { period: issue.period } : {}), ...(issue.kind ? { kind: issue.kind } : {}),
      ...(issue.item_index !== undefined ? { item_index: issue.item_index } : {}), ...(issue.priority !== undefined ? { priority: issue.priority } : {}),
      ...(replacement !== undefined ? { replacement } : {}), ...(choices ? { choices } : {}) });
  }
  return { submit_tool: submitTool,
    instruction: stopped ? "修正已停止,交由程序执行退出或降级;不要继续调用工具。" : submitTool === "submit_analysis"
      ? "先修正本次列出的独立错误,再完整提交四期报告;不要调用局部修正工具。"
      : submitTool === "repair_analysis_group" ? "仅修正 targets 指定的现有组,复制 pending_groups 中原组并按 corrections 修改后调用局部修正;保留其他组。" : "当前没有待处理的校验错误。",
    targets: submitTool === "repair_analysis_group" ? targets : [], corrections, evidence_actions: stopped ? [] : actions };
}
