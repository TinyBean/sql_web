import { Type, type Static, type TSchema } from "typebox";
import { Value } from "typebox/value";
import { parseDashboardState, type DashboardRow, type DashboardState } from "../../../../shared/dashboard.ts";
import type { AnalysisContext, Evidence } from "./agent.ts";
import { ANALYSIS_PERIOD_KEYS, type PeriodKey } from "../calculate/periods.ts";
import { createAnalysisTemplate } from "../template.ts";
import { normalizeDataSnapshotName } from "../../../tool/artifact-store.ts";
import { formatMachineMentions, hasMachineDistributionClaim } from "../../../skills/test-oee-calculator/assets/machine-platforms.ts";
import { machineRankingView } from "../../../skills/test-oee-calculator/assets/machine-ranking.ts";

const ANALYSIS_KEYS = new Map(ANALYSIS_PERIOD_KEYS.map((key) => [createAnalysisTemplate(key).id, key]));

const narrativeDescription = "报告正文字符串，允许空字符串和纯空白；建议用业务用户可理解的中文说明事实、依据和措施。";
const text = Type.String({ description: narrativeDescription });
const refs = Type.Array(Type.String({ minLength: 1 }), { minItems: 1, maxItems: 12 });
export const ANALYSIS_CATEGORY_RULES = "类别固定为 availability；每项对应程序选定的一个损失状态，机台排名使用 loss_hours，并且 states 仅包含该状态。本期损失小时来自完整状态汇总，不折算 Performance/Yield。";
export const PeriodKeySchema = Type.Union([Type.Literal("day"), Type.Literal("week"), Type.Literal("month"), Type.Literal("quarter")]);
const AnalysisKindSchema = Type.Union([Type.Literal("MT"), Type.Literal("ST")]);
const AnalysisItemSchema = Type.Object({
  priority: Type.Integer({ minimum: 1, maximum: 3 }),
  category: Type.Literal("availability", { description: ANALYSIS_CATEGORY_RULES }),
  issue: text, measure: text,
  suggested_owner: text,
  evidence_ids: Type.Array(Type.String({ minLength: 1 }), { minItems: 1, maxItems: 12,
    description: "本建议使用的全部真实证据编号，必须包含 loss_reference.evidence_id 及 machine_evidence_ids。" }),
  machine_evidence_ids: Type.Array(Type.String({ minLength: 1 }), { minItems: 1, maxItems: 12,
    description: "仅接受 source=rank_machines 的本周期、同 MT/ST、同日期范围、单个入选状态的完整 loss_hours/report_period 排名。measure_loss 的 ranking 或 machine_summaries 不是合格来源，禁止填入其编号。编号同时加入 evidence_ids。" }),
  loss_reference: Type.Object({ evidence_id: Type.String({ minLength: 1 }), row_index: Type.Integer({ minimum: 0 }) },
    { additionalProperties: false, description: "必填；引用程序提供的本期完整损失证据和入选状态原始行号。" }),
}, { additionalProperties: false });
const AnalysisGroupSchema = Type.Object({
  kind: AnalysisKindSchema,
  no_findings_reason: text,
  evidence_ids: refs,
  items: Type.Array(AnalysisItemSchema, { maxItems: 3 }),
}, { additionalProperties: false });
const AnalysisPeriodSchema = Type.Object({
  period: PeriodKeySchema, comparison: text,
  minimum_evidence: Type.String(), history_evidence: Type.String(),
  groups: Type.Array(AnalysisGroupSchema, { minItems: 2, maxItems: 2 }),
}, { additionalProperties: false });
const reportSchema = (periodCount: number) => Type.Object({
  periods: Type.Array(AnalysisPeriodSchema, { minItems: periodCount, maxItems: periodCount }),
}, { additionalProperties: false });
export const AnalysisReportSchema = reportSchema(4);
const AnalysisCandidateSchema = reportSchema(1);

export type AnalysisReport = Static<typeof AnalysisReportSchema>;
type AnalysisGroup = Static<typeof AnalysisGroupSchema>;

export interface AnalysisValidationIssue {
  readonly code: string;
  readonly path: string;
  readonly period?: PeriodKey;
  readonly kind?: "MT" | "ST";
  readonly priority?: number;
  readonly item_index?: number;
  readonly evidence_id?: string;
  readonly expected: unknown;
  readonly actual: unknown;
  readonly message: string;
  readonly hint: string;
  readonly reason?: string;
  readonly reasons?: readonly string[];
}

export class AnalysisValidationError extends Error {
  readonly issues: readonly AnalysisValidationIssue[];
  readonly has_more: boolean;
  constructor(issues: readonly AnalysisValidationIssue[], hasMore = false) {
    const summary = issues.slice(0, 3).map((issue) => [issue.code, issue.period, issue.kind, issue.path,
      issue.evidence_id, issue.message].filter(Boolean).join(" / ").slice(0, 180)).join("；");
    super(summary.slice(0, 420) + (issues.length > 1 || hasMore
      ? `；详见 analysis_repair.issues（本次 ${issues.length} 条${hasMore ? "，还有更多" : ""}）。` : ""));
    this.name = "AnalysisValidationError";
    this.issues = issues;
    this.has_more = hasMore;
  }
}

export interface AnalysisExclusion {
  readonly period: PeriodKey;
  readonly kind: "MT" | "ST";
  readonly priority: number;
  readonly item: AnalysisGroup["items"][number];
  readonly issues: readonly AnalysisValidationIssue[];
}

export type AnalysisExclusionSummary = {
  readonly period: PeriodKey;
  readonly kind: "MT" | "ST";
  readonly priority: number;
  readonly codes: readonly string[];
};
export interface AnalysisPublication {
  readonly status: "completed" | "degraded";
  readonly exclusions: readonly AnalysisExclusionSummary[];
}
export interface AnalysisResult {
  readonly report: AnalysisReport;
  readonly rows: Record<PeriodKey, DashboardRow[]>;
  readonly status: "completed" | "degraded";
  readonly exclusions: readonly AnalysisExclusion[];
}

const ANALYSIS_PERIOD_NAMES: Record<PeriodKey, string> = { day: "日", week: "周", month: "月", quarter: "季度" };
export function analysisExclusionSummary(exclusions: readonly Pick<AnalysisExclusion, "period" | "kind">[]): string {
  const counts = new Map<string, number>();
  for (const entry of exclusions) {
    const label = ANALYSIS_PERIOD_NAMES[entry.period] + " " + entry.kind;
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  return "报告降级：" + [...counts].map(([label, count]) => label + " 剔除 " + count + " 条未通过证据校验的建议").join("；");
}

/** Decode only structural fields; never guess repairs or echo report contents. */
function decodeAnalysisStructures(value: unknown): unknown {
  const structural = new Set(["periods", "groups", "group", "items", "evidence_ids", "machine_evidence_ids", "loss_reference", "omitted_candidates"]);
  const issues: AnalysisValidationIssue[] = [];
  let hasMore = false;
  const decode = (input: unknown, key = "", location = ""): unknown => {
    if (structural.has(key) && typeof input === "string") {
      try { input = JSON.parse(input) as unknown; }
      catch (error) {
        const position = error instanceof Error ? error.message.match(/position \d+|line \d+ column \d+/gu)?.join("; ") : undefined;
        if (issues.length === MAX_STRUCTURE_ISSUES) { hasMore = true; return input; }
        issues.push({ code: "STRUCTURE_INVALID", path: location || "/", ...structureLocation(value, location),
          reason: "invalid_json", expected: "数组/对象或合法的 JSON 字符串", actual: "无效 JSON 字符串",
          message: "结构字段不是合法的 JSON" + (position ? "（" + position + "）" : ""),
          hint: "直接传结构化数组/对象，修正该字段，不要将整个报告转成字符串。" });
        return input;
      }
    }
    if (Array.isArray(input)) return input.map((entry, index) => decode(entry, "", location + "/" + index));
    if (input && typeof input === "object") {
      return Object.fromEntries(Object.entries(input).map(([name, entry]) => [name, decode(entry, name,
        location + "/" + name.replaceAll("~", "~0").replaceAll("/", "~1"))]));
    }
    return input;
  };
  const decoded = decode(value);
  if (issues.length) throw new AnalysisValidationError(issues, hasMore);
  return decoded;
}

export function parseAnalysisReport(value: unknown): AnalysisReport {
  return parseReport(value, AnalysisReportSchema);
}

function parseReport(value: unknown, schema: typeof AnalysisReportSchema): AnalysisReport {
  const decoded = decodeAnalysisStructures(value);
  if (!Value.Check(schema, decoded)) {
    const result = structureIssues(schema, decoded);
    throw new AnalysisValidationError(result.issues, result.has_more);
  }
  return decoded;
}

/** Acceptance checks report structure and frozen evidence, not narrative or selection policy. */
export function validateAnalysisReport(
  input: unknown, context: AnalysisContext, evidence: ReadonlyMap<string, Evidence>,
): AnalysisResult {
  return validateReport(parseAnalysisReport(input), context, evidence, ANALYSIS_PERIOD_KEYS);
}

function validateReport(
  value: AnalysisReport, context: AnalysisContext, evidence: ReadonlyMap<string, Evidence>, periods: readonly PeriodKey[],
): AnalysisResult {
  const issues: AnalysisValidationIssue[] = [];
  const rows = {} as Record<PeriodKey, DashboardRow[]>;
  const renderedItems = new Map<AnalysisGroup["items"][number], DashboardRow>();
  const renderedComparisons = new Map<AnalysisReport["periods"][number], string>();
  type Location = Pick<AnalysisValidationIssue, "period" | "kind" | "priority" | "item_index">;
  const add = (location: Location, path: string, code: string, message: string, expected: unknown, actual: unknown,
    hint = "只修正定位字段，保留已核实的其他内容。", evidence_id?: string): void => {
    issues.push({ ...location, path, code, message, expected, actual, hint, ...(evidence_id ? { evidence_id } : {}) });
  };
  const ref = (id: string, location: Location, path: string): Evidence | undefined => {
    const record = evidence.get(id);
    if (!record) { add(location, path, "EVIDENCE_MISSING", "证据不存在", "本次运行已保存的证据", "不存在", "先复用证据目录中同范围的证据；确实缺少时再补查。", id); return; }
    if (record.truncated) { add(location, path, "EVIDENCE_TRUNCATED", "证据被截断", false, true, "补查完整证据，不能用截断预览支持结论。", id); return; }
    if (record.owner?.period !== location.period) {
      add(location, path, "EVIDENCE_PERIOD_MISMATCH", "证据不属于本周期", location.period, record.owner?.period ?? null,
        "复用归属本周期的证据；即使日期相同，也不能跨周期引用。", id); return;
    }
    return record;
  };
  const refs = (ids: readonly string[], location: Location, path: string): void => {
    ids.forEach((id, index) => ref(id, location, path + "/" + index));
  };
  for (const key of periods) {
    const matching = value.periods.map((report, index) => ({ report, index })).filter(({ report }) => report.period === key);
    if (matching.length !== 1) {
      add({ period: key }, "/periods", "PERIOD_COVERAGE", "每个周期必须且只能提交一次", 1, matching.length); continue;
    }
    const { report, index: periodIndex } = matching[0]!;
    const periodPath = "/periods/" + periodIndex;
    const periodLocation = { period: key };
    const expected = context.comparisons[key];
    for (const [field, baseline] of [["minimum_evidence", expected.minimum], ["history_evidence", expected.history]] as const) {
      if (report[field] !== baseline.id) add(periodLocation, periodPath + "/" + field, "BASELINE_MISMATCH",
        "最低点或历史证据引用不匹配初始上下文", baseline.id, report[field], "直接使用初始上下文指定的证据编号。");
      else ref(report[field], periodLocation, periodPath + "/" + field);
    }
    rows[key] = [];
    const periodSummaries = new Set<string>();
    for (const kind of ["MT", "ST"] as const) {
      const matchingGroups = report.groups.map((group, index) => ({ group, index })).filter(({ group }) => group.kind === kind);
      const groupLocation = { period: key, kind };
      if (matchingGroups.length !== 1) {
        add(groupLocation, periodPath + "/groups", "KIND_COVERAGE", "必须分别覆盖 MT 和 ST", 1, matchingGroups.length); continue;
      }
      const { group, index: groupIndex } = matchingGroups[0]!;
      const groupPath = periodPath + "/groups/" + groupIndex;
      const selection = context.losses[key];
      const candidates = selection.by_kind[kind];
      refs(group.evidence_ids, groupLocation, groupPath + "/evidence_ids");
      if (!group.evidence_ids.includes(expected.current.id)) add(groupLocation, groupPath + "/evidence_ids", "CURRENT_EVIDENCE_MISSING", "缺少本期指标证据", expected.current.id, group.evidence_ids);
      if (!group.evidence_ids.includes(selection.evidence_id)) add(groupLocation, groupPath + "/evidence_ids", "CURRENT_LOSS_EVIDENCE_MISSING", "缺少程序提供的本期完整损失证据", selection.evidence_id, group.evidence_ids);
      for (const [itemIndex, item] of group.items.entries()) {
        const itemPath = groupPath + "/items/" + itemIndex;
        const location = { ...groupLocation, priority: item.priority, item_index: itemIndex };
        const itemIssueStart = issues.length;
        refs(item.evidence_ids, location, itemPath + "/evidence_ids");
        const reference = item.loss_reference;
        const candidate = reference.evidence_id === selection.evidence_id
          ? candidates.find((entry) => entry.row_index === reference.row_index) : undefined;
        const rankings: { record: Evidence; summary: string }[] = [];
        for (const [rankingIndex, id] of item.machine_evidence_ids.entries()) {
          const rankingPath = itemPath + "/machine_evidence_ids/" + rankingIndex;
          const ranking = ref(id, location, rankingPath);
          if (!ranking) continue;
          if (!item.evidence_ids.includes(id)) add(location, rankingPath, "RANKING_REFERENCE_MISSING", "TOP3 证据必须同时列入 evidence_ids", id, item.evidence_ids, "将已有排名编号同时加入 evidence_ids。", id);
          if (ranking.source !== "rank_machines" || !ranking.rankingScope) {
            add(location, rankingPath, "RANKING_SOURCE_MISMATCH", "TOP3 必须引用完整排名证据", "rank_machines", ranking.source ?? null, "复用已有排名；缺少时调用标准排名工具。", id); continue;
          }
          const scope = ranking.rankingScope;
          const rankingIssueStart = issues.length;
          if (ranking.range?.start !== context.periods[key].start || ranking.range.end !== context.periods[key].end) add(location, rankingPath, "RANKING_RANGE_MISMATCH", "TOP3 日期范围不匹配本期", context.periods[key], ranking.range ?? null, "复用本周期完整日期范围的排名。", id);
          if (scope.kind !== kind || ranking.rows.some((row) => row["kind"] !== kind)) add(location, rankingPath, "RANKING_KIND_MISMATCH", "TOP3 必须引用同类型机台排名", kind, { scope: scope.kind, rows: [...new Set(ranking.rows.map((row) => row["kind"]))] }, "复用同 MT/ST 的排名。", id);
          if (scope.basis !== "report_period") add(location, rankingPath, "RANKING_BASIS_MISMATCH", "TOP3 必须引用完整整期排名证据", "report_period", scope.basis, "固定报告使用 report_period，不使用 machine_day。", id);
          if (scope.metric !== "loss_hours") add(location, rankingPath, "METRIC_CATEGORY_MISMATCH", "损失问题必须引用损失小时机台排名", ["loss_hours"], { category: item.category, metric: scope.metric }, "复用该损失状态的 loss_hours 排名。", id);
          if (candidate && (scope.states.length !== 1 || scope.states[0] !== candidate.state_group)) add(location, rankingPath, "LOSS_STATE_MISMATCH", "损失问题的机台 TOP3 必须精确匹配单个入选状态", candidate.state_group, scope.states,
            "仅使用该状态的已有排名；缺少时补查。", selection.evidence_id);
          if (issues.length === rankingIssueStart && !rankings.some(({ record }) => record.id === id)) rankings.push({ record: ranking, summary: machineRankingView({ rows: ranking.rows, range: ranking.range!, scope }).summary });
        }
        let hours: number | null = null;
        {
          const lossPath = itemPath + "/loss_reference";
          const measured = ref(reference.evidence_id, location, lossPath + "/evidence_id");
          if (measured) {
            const row = measured.rows[reference.row_index];
            const reasons = [
              ...(!item.evidence_ids.includes(measured.id) ? ["损失证据未加入建议的 evidence_ids"] : []),
              ...(reference.evidence_id !== selection.evidence_id ? ["必须使用程序提供的本期完整损失证据编号"] : []),
              ...(measured.source !== "measure_loss" ? ["来源必须为 measure_loss"] : []),
              ...(measured.range?.start !== context.periods[key].start || measured.range.end !== context.periods[key].end ? ["日期范围必须与本期完全一致"] : []),
              ...(measured.lossScope?.byMachine !== false || measured.lossScope.states.length !== 0 || measured.lossScope.machines.length !== 0 ? ["必须使用未按机台、状态或机台列表过滤的完整状态汇总"] : []),
              ...(!row ? ["原始 row_index 越界或不存在"] : []),
              ...(!candidate ? ["行号未对应本期同类型的入选候选；不得将 priority 或 item_index 当作 row_index"] : []),
              ...(row && row["kind"] !== kind ? ["原始行的 MT/ST 类型不匹配"] : []),
              ...(candidate && row && row["state_group"] !== candidate.state_group ? ["原始行的损失状态不匹配"] : []),
              ...(typeof row?.["loss_hours"] !== "number" || !Number.isFinite(row["loss_hours"]) ? ["损失小时必须为有限数字"] :
                candidate && row["loss_hours"] !== candidate.loss_hours ? ["损失小时与入选候选保存的原始值不一致"] : []),
            ];
            if (reasons.length) issues.push({ ...location, path: lossPath, code: "LOSS_REFERENCE_MISMATCH", evidence_id: measured.id,
              expected: { evidence_id: selection.evidence_id, source: "measure_loss", range: context.periods[key], kind, candidates },
              actual: { source: measured.source ?? null, range: measured.range ?? null, loss_scope: measured.lossScope ?? null,
                row_index: reference.row_index, row: row ? { kind: row["kind"], state_group: row["state_group"], loss_hours: diagnosticValue(row["loss_hours"]) } : null,
                included: item.evidence_ids.includes(measured.id) }, reasons,
              message: "损失小时必须引用程序提供的本期同类型完整状态汇总入选行：" + reasons.join("；"),
              hint: "使用 repair_plan 中的合法损失候选及原始行号，保留其他建议；多个候选需按分析对象选择。" });
            else {
              hours = row!["loss_hours"] as number;
            }
          }
        }
        if (issues.length !== itemIssueStart) continue;
        const machines = rankings.flatMap(({ record }) => record.rows.map((row) => String(row["machine"])));
        const issue = [formatMachineMentions(item.issue, machines), ...rankings.map(({ summary }) => summary).filter((summary) => !item.issue.includes(summary))].join("\n");
        for (const { summary } of rankings) periodSummaries.add(summary);
        const row = { kind, priority: item.priority, issue, measure: formatMachineMentions(item.measure, machines),
          suggested_owner: formatMachineMentions(item.suggested_owner, machines) + "（职能建议，待人工确认）", loss_hours: hours };
        renderedItems.set(item, row);
        rows[key].push(row);
      }
      rows[key].sort((a, b) => String(a["kind"]).localeCompare(String(b["kind"])) || Number(a["priority"]) - Number(b["priority"]));
    }
    let comparison = formatMachineMentions(report.comparison);
    // Distribution wording only controls display enrichment, never acceptance.
    if (periodSummaries.size && hasMachineDistributionClaim(comparison)) {
      comparison = [comparison, ...[...periodSummaries].filter((summary) => !comparison.includes(summary))].join("\n");
    }
    renderedComparisons.set(report, comparison);
  }
  if (issues.length) throw new AnalysisValidationError(issues);
  // All normalization happens on the decoded copy, after every check succeeds.
  for (const period of value.periods) {
    period.comparison = renderedComparisons.get(period)!;
    for (const group of period.groups) {
      group.no_findings_reason = formatMachineMentions(group.no_findings_reason);
      for (const item of group.items) {
        const row = renderedItems.get(item)!;
        item.issue = String(row["issue"]);
        item.measure = String(row["measure"]);
        item.suggested_owner = String(row["suggested_owner"]).replace(/（职能建议，待人工确认）$/u, "");
      }
    }
  }
  return { report: value, rows, status: "completed", exclusions: [] };
}

/** Preflight uses the publication rules without accepting a report or spending repair attempts. */
export function inspectAnalysisCandidate(
  text: string, period: PeriodKey, context: AnalysisContext, evidence: ReadonlyMap<string, Evidence>,
) {
  let candidate: AnalysisReport | undefined;
  try {
    let input: unknown;
    try {
      // Some final replies introduce their JSON with a sentence or a Markdown fence.
      // Accept exactly one complete object; never merge fragments or choose among multiple candidates.
      const start = text.indexOf("{"), end = text.lastIndexOf("}");
      if (start < 0 || end < start || !/^(?:\s*```)?\s*$/u.test(text.slice(end + 1))) throw new Error("incomplete candidate");
      input = JSON.parse(text.slice(start, end + 1)) as unknown;
    }
    catch {
      throw new AnalysisValidationError([{ code: "STRUCTURE_INVALID", path: "/", period,
        expected: "单周期 JSON 对象", actual: "无法解析的 JSON", message: "子任务未返回合法的单周期 JSON",
        hint: "从本周期冻结证据组装候选，不把自由文本或 Markdown 当作合格报告。" }]);
    }
    candidate = parseReport({ periods: [input] }, AnalysisCandidateSchema);
    validateReport(candidate, context, evidence, [period]);
    return { status: "valid" as const, issues: [], has_more: false, corrections: [], evidence_actions: [] };
  } catch (error) {
    if (!(error instanceof AnalysisValidationError)) throw error;
    const plan = analysisRepairPlan(context, evidence, candidate, error.issues, error.issues, { tool: "submit_analysis" }, false);
    return { status: "needs_repair" as const, issues: error.issues, has_more: error.has_more,
      corrections: plan.corrections.map((correction) => ({ ...correction, argument_path: correction.report_path ?? correction.path })),
      evidence_actions: plan.evidence_actions };
  }
}

/** Only item-scoped evidence failures can be discarded; survivors retain their submitted priority. */
export function degradeAnalysisReport(input: AnalysisReport, context: AnalysisContext, evidence: ReadonlyMap<string, Evidence>): AnalysisResult {
  let issues: readonly AnalysisValidationIssue[];
  try { return validateAnalysisReport(input, context, evidence); }
  catch (error) { if (!(error instanceof AnalysisValidationError)) throw error; issues = error.issues; }
  if (issues.some((issue) => issue.item_index === undefined)) throw new AnalysisValidationError(issues);
  const candidate = parseAnalysisReport(input);
  const exclusions: AnalysisExclusion[] = [];
  for (const period of candidate.periods) {
    let affected = false;
    for (const group of period.groups) {
      group.items = group.items.filter((item, index) => {
        const itemIssues = issues.filter((issue) => issue.period === period.period && issue.kind === group.kind && issue.item_index === index);
        if (!itemIssues.length) return true;
        exclusions.push({ period: period.period, kind: group.kind, priority: item.priority, item: structuredClone(item), issues: itemIssues });
        affected = true;
        return false;
      }).sort((a, b) => a.priority - b.priority);
      if (!group.items.length && exclusions.some((entry) => entry.period === period.period && entry.kind === group.kind)) {
        group.no_findings_reason = "部分建议未通过证据校验，暂无可展示建议";
      }
    }
    if (affected) period.comparison = "本周期部分改善建议未通过证据校验，已从报告中剔除；周期趋势判断暂未提供，请结合已展示指标核对。";
  }
  const result = validateAnalysisReport(candidate, context, evidence);
  return { ...result, status: "degraded", exclusions };
}

export function applyAnalysisReport(
  state: DashboardState, result: ReturnType<typeof validateAnalysisReport>,
): DashboardState {
  return parseDashboardState({ ...state, widgets: state.widgets.map((widget) => {
    const key = ANALYSIS_KEYS.get(widget.id);
    if (!key) return widget;
    const report = result.report.periods.find((period) => period.period === key)!;
    return {
      ...widget, data: result.rows[key],
      warnings: [
        ...widget.warnings.filter((warning) => !warning.startsWith("本次分析暂不可用")),
        ...result.exclusions.filter((entry) => entry.period === key).map((entry) =>
          ANALYSIS_PERIOD_NAMES[key] + " " + entry.kind + " 原第 " + entry.priority + " 条建议未通过证据校验，已剔除，请人工核实"),
        ...report.groups.filter((group) => !group.items.length).map((group) =>
          (group.kind + " 未生成建议：" + group.no_findings_reason).slice(0, 300)),
        ...result.rows[key].filter((row) => typeof row["issue"] === "string" && row["issue"].includes("平台待维护/"))
          .map(() => "机台平台映射待维护；未知平台机台保留真实数值与排名，请补充映射"),
      ],
    };
  }) });
}

export function analysisUnavailable(state: DashboardState, reason: string): DashboardState {
  return parseDashboardState({ ...state, widgets: state.widgets.map((widget) => {
    if (!ANALYSIS_KEYS.has(widget.id)) return widget;
    return {
      ...widget, data: [], warnings: [
        ...widget.warnings.filter((warning) => !warning.startsWith("本次分析暂不可用")),
        ("本次分析暂不可用：" + reason).slice(0, 300),
      ],
    };
  }) });
}

const MAX_STRUCTURE_ISSUES = 8;
const pointerToken = (value: string): string => value.replaceAll("~", "~0").replaceAll("/", "~1");

export function pointerValue(value: unknown, path: string): unknown {
  if (!path || path === "#") return value;
  for (const token of path.replace(/^#/u, "").slice(1).split("/")) {
    const key = token.replaceAll("~1", "/").replaceAll("~0", "~");
    if (!value || typeof value !== "object" || !Object.hasOwn(value, key)) return undefined;
    value = (value as Record<string, unknown>)[key];
  }
  return value;
}

/** Diagnostics expose the offending scalar or shape, never a report or database row. */
function diagnosticValue(value: unknown): unknown {
  if (value === undefined) return { type: "missing" };
  if (typeof value === "number" && !Number.isFinite(value)) return { type: "number", value: String(value) };
  if (typeof value === "string") return value.length > 160 ? value.slice(0, 160) + "…" : value;
  if (Array.isArray(value)) return { type: "array", length: value.length };
  if (value && typeof value === "object") return { type: "object", keys: Object.keys(value).slice(0, 12) };
  return value;
}

function structureLocation(input: unknown, path: string): Pick<AnalysisValidationIssue, "period" | "kind" | "item_index" | "priority"> {
  const periodPath = path.match(/^\/periods\/\d+/u)?.[0];
  const groupPath = path.match(/^\/periods\/\d+\/groups\/\d+/u)?.[0] ?? (path.startsWith("/group/") ? "/group" : undefined);
  const itemPath = path.match(/^(?:\/periods\/\d+\/groups\/\d+|\/group)\/items\/(\d+)/u);
  const period = pointerValue(input, periodPath ? periodPath + "/period" : "/period");
  const kind = pointerValue(input, periodPath && groupPath ? groupPath + "/kind" : "/kind");
  const priority = itemPath ? pointerValue(input, itemPath[0] + "/priority") : undefined;
  return {
    ...(ANALYSIS_PERIOD_KEYS.includes(period as PeriodKey) ? { period: period as PeriodKey } : {}),
    ...(kind === "MT" || kind === "ST" ? { kind } : {}),
    ...(itemPath ? { item_index: Number(itemPath[1]) } : {}),
    ...(typeof priority === "number" && Number.isInteger(priority) ? { priority } : {}),
  };
}

/** Expand required/extra properties into precise JSON Pointers and bound independent errors. */
function structureIssues(schema: TSchema, input: unknown): { issues: AnalysisValidationIssue[]; has_more: boolean } {
  const issues: AnalysisValidationIssue[] = [];
  const seen = new Set<string>();
  for (const error of Value.Errors(schema, input)) {
    // TypeBox reports each failed literal branch before the union error. Reporting a
    // single branch would incorrectly tell the model to replace every invalid period with day.
    const unionPath = error.schemaPath.match(/^(.*)\/anyOf\/\d+(?:\/.*)?$/u)?.[1];
    const union = unionPath === undefined ? undefined : pointerValue(schema, unionPath) as Record<string, unknown> | undefined;
    if (Array.isArray(union?.["anyOf"]) && union["anyOf"].every((entry: Record<string, unknown>) => Object.hasOwn(entry, "const"))) continue;
    const params = error.params as Record<string, unknown>;
    const definition = pointerValue(schema, error.schemaPath) as Record<string, unknown> | undefined;
    const names = error.keyword === "required" ? params["requiredProperties"] :
      error.keyword === "additionalProperties" ? params["additionalProperties"] : undefined;
    for (const name of Array.isArray(names) ? names : [undefined]) {
      const path = error.instancePath + (typeof name === "string" ? "/" + pointerToken(name) : "");
      const key = error.keyword + ":" + path;
      if (seen.has(key)) continue;
      seen.add(key);
      if (issues.length === MAX_STRUCTURE_ISSUES) return { issues, has_more: true };
      const field = error.keyword === "required" && typeof name === "string"
        ? (definition?.["properties"] as Record<string, Record<string, unknown>> | undefined)?.[name] : definition;
      const constraints = Object.fromEntries(Object.entries(field ?? {}).filter(([key]) =>
        ["type", "const", "enum", "minimum", "maximum", "minItems", "maxItems", "minLength"].includes(key)));
      if (Array.isArray(field?.["anyOf"])) constraints["enum"] = field["anyOf"].flatMap((entry: Record<string, unknown>) =>
        Object.hasOwn(entry, "const") ? [entry["const"]] : []);
      const expected = error.keyword === "additionalProperties" ? { allowed_fields: Object.keys((definition?.["properties"] as object | undefined) ?? {}) }
        : constraints;
      const rule = error.keyword === "required" ? "缺少必填字段" : error.keyword === "additionalProperties" ? "存在未定义字段，请删除此字段"
        : error.keyword === "const" || error.keyword === "anyOf" || error.keyword === "enum" ? "字段值不在允许范围内"
          : ["minItems", "maxItems"].includes(error.keyword) ? "数组项数不符合限制"
            : ["minimum", "maximum"].includes(error.keyword) ? "数字超出允许范围" : "字段类型或内容不符合要求";
      issues.push({ code: "STRUCTURE_INVALID", path: path || "/", ...structureLocation(input, path),
        reason: error.keyword, expected, actual: diagnosticValue(pointerValue(input, path)),
        message: "字段或结构无效：" + rule,
        hint: rule + "；按 expected 修正该字段，保留其他内容。数组下标 item_index、优先级 priority、证据原始行号 row_index 含义不同。" });
    }
  }
  return { issues, has_more: false };
}

interface RepairTarget { readonly period: PeriodKey; readonly kind: "MT" | "ST" }
interface RepairAttempt { readonly tool: "submit_analysis" | "repair_analysis_group"; readonly target?: RepairTarget }
interface RepairCorrection {
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
interface EvidenceAction extends RepairTarget {
  readonly action: "reuse" | "query" | "investigate";
  readonly instruction: string;
  readonly item_index?: number;
  readonly evidence_ids?: readonly string[];
  readonly tool?: string;
  readonly arguments?: Readonly<Record<string, unknown>>;
}
interface AnalysisRepairPlan {
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

function pendingRepairTargets(candidate: AnalysisReport | undefined, issues: readonly AnalysisValidationIssue[]): RepairTarget[] {
  return candidate?.periods.flatMap((period) => period.groups.filter((group) =>
    issues.some((issue) => issue.period === period.period && issue.kind === group.kind))
    .map((group) => ({ period: period.period, kind: group.kind }))) ?? [];
}

/** A single plan drives tool feedback, dynamic context and permission to acquire more evidence. */
function analysisRepairPlan(
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

const MAX_REPORT_REPAIRS = 3;
const REPORT_REPAIR_TIMEOUT_MS = 120_000;
const ANALYSIS_CLEANUP_RESERVE_MS = 10_000;

export const RepairAnalysisGroupSchema = Type.Object({
  period: PeriodKeySchema, kind: AnalysisKindSchema, group: AnalysisGroupSchema,
  omitted_candidates: Type.Optional(Type.Array(Type.Object({
    item: AnalysisItemSchema, reason: Type.String(),
  }, { additionalProperties: false }), { maxItems: 12 })),
}, { additionalProperties: false });

/** Semantic fingerprints ignore prose and regenerated evidence IDs. */
function fingerprint(issues: readonly AnalysisValidationIssue[]): Set<string> {
  const normalize = (value: unknown): unknown => {
    if (typeof value === "string" && /^q\d+$/u.test(value)) return "evidence";
    if (Array.isArray(value)) return value.map(normalize);
    if (value && typeof value === "object") return Object.fromEntries(Object.entries(value)
      .filter(([key]) => key !== "evidence_id").sort(([a], [b]) => a.localeCompare(b)).map(([key, entry]) => [key, normalize(entry)]));
    return value;
  };
  return new Set(issues.map((issue) => JSON.stringify([issue.code, issue.period, issue.kind, issue.item_index,
    issue.path.replace(/\/\d+$/u, "/reference"), normalize(issue.expected), normalize(issue.actual)])));
}

/** Owns the unrendered candidate and bounded repair state independently of model history. */
export class AnalysisRepairState {
  #candidate: AnalysisReport | undefined;
  #issues: readonly AnalysisValidationIssue[] = [];
  #feedback: readonly AnalysisValidationIssue[] = [];
  #previousFingerprints = new Set<string>();
  #failures = 0;
  #failedRepairs = 0;
  #repairDeadline: number | undefined;
  #stopReason: string | undefined;
  #hasMore = false;
  #lastAttempt: RepairAttempt = { tool: "submit_analysis" };

  readonly context: AnalysisContext;
  readonly evidence: ReadonlyMap<string, Evidence>;
  readonly deadline: number;
  readonly onEvent: (event: Record<string, unknown>) => void;
  constructor(context: AnalysisContext, evidence: ReadonlyMap<string, Evidence>, deadline: number,
    onEvent: (event: Record<string, unknown>) => void) {
    this.context = context; this.evidence = evidence; this.deadline = deadline; this.onEvent = onEvent;
  }

  get active(): boolean { return this.#failures > 0; }
  get repairDeadline(): number | undefined { return this.#repairDeadline; }
  get stopReason(): string | undefined { return this.#stopReason; }

  prepareReport(input: unknown): AnalysisReport {
    this.#lastAttempt = { tool: "submit_analysis" };
    try { return parseAnalysisReport(input); }
    catch (error) { this.#rejectStructure(error); throw error; }
  }

  prepareGroup(input: unknown): Static<typeof RepairAnalysisGroupSchema> {
    const period = pointerValue(input, "/period");
    const kind = pointerValue(input, "/kind");
    this.#lastAttempt = { tool: "repair_analysis_group",
      ...(ANALYSIS_PERIOD_KEYS.includes(period as PeriodKey) && (kind === "MT" || kind === "ST")
        ? { target: { period: period as PeriodKey, kind } } : {}) };
    try {
      const decoded = decodeAnalysisStructures(input);
      if (!Value.Check(RepairAnalysisGroupSchema, decoded)) {
        const result = structureIssues(RepairAnalysisGroupSchema, decoded);
        throw new AnalysisValidationError(result.issues, result.has_more);
      }
      return decoded;
    } catch (error) { this.#rejectStructure(error); throw error; }
  }

  submit(candidate: AnalysisReport, target?: { period: PeriodKey; kind: "MT" | "ST" }): AnalysisResult | undefined {
    this.#lastAttempt = target ? { tool: "repair_analysis_group", target } : { tool: "submit_analysis" };
    this.#candidate = structuredClone(candidate);
    this.onEvent({ type: "analysis_candidate", report: this.#candidate });
    try { return validateAnalysisReport(this.#candidate, this.context, this.evidence); }
    catch (error) {
      if (!(error instanceof AnalysisValidationError)) throw error;
      this.#issues = error.issues;
      this.#reject(error.issues, target);
      return undefined;
    }
  }

  repair(params: Static<typeof RepairAnalysisGroupSchema>): AnalysisResult | undefined {
    this.#lastAttempt = { tool: "repair_analysis_group", target: { period: params.period, kind: params.kind } };
    const invalid = !this.#candidate ? "尚无结构合法的完整候选，请先调用 submit_analysis。" :
      params.group.kind !== params.kind ? "group.kind 必须与待修正的 kind 一致。" :
      !this.#issues.some((issue) => issue.period === params.period && issue.kind === params.kind) ? "只能修正当前校验指出的周期和类型。" : null;
    if (invalid) {
      this.#reject([{ code: "REPAIR_TARGET_INVALID", path: "/group", period: params.period, kind: params.kind,
        expected: this.#candidate ? this.modelContext().repair_plan.targets : "先用 submit_analysis 提交结构合法的完整四期报告",
        actual: { period: params.period, kind: params.kind, group_kind: params.group.kind }, message: invalid,
        hint: !this.#candidate ? "调用 submit_analysis 完整提交四期报告；尚不能调用 repair_analysis_group。" : "按 repair_plan.submit_tool 和 targets 选择修正方式。" }]);
      return undefined;
    }
    const next = structuredClone(this.#candidate!);
    const period = next.periods.find((entry) => entry.period === params.period)!;
    const index = period.groups.findIndex((group) => group.kind === params.kind);
    if (index < 0) {
      this.#reject([{ code: "REPAIR_TARGET_INVALID", path: "/group", period: params.period, kind: params.kind,
        expected: "已有目标组", actual: "缺少组", message: "候选缺少目标组，请完整重提。", hint: "用 submit_analysis 修正分组结构。" }]);
      return undefined;
    }
    period.groups[index] = structuredClone(params.group);
    this.onEvent({ type: "analysis_group_repair", period: params.period, kind: params.kind,
      omitted_candidates: params.omitted_candidates ?? [] });
    return this.submit(next, { period: params.period, kind: params.kind });
  }

  stop(reason: string): void {
    this.#stopReason ??= reason;
  }

  degrade(): AnalysisResult {
    if (!this.#candidate) throw new Error(this.#stopReason ?? "未提交结构合法的完整候选报告");
    return degradeAnalysisReport(this.#candidate, this.context, this.evidence);
  }

  modelContext() {
    const groups = this.#candidate?.periods.flatMap((period) => period.groups.filter((group) =>
      this.#issues.some((issue) => issue.period === period.period && issue.kind === group.kind))
      .map((group) => ({ period: period.period, kind: group.kind, group }))) ?? [];
    return { active: this.active, issues: this.#feedback, has_more: this.#hasMore, pending_groups: groups,
      repair_plan: analysisRepairPlan(this.context, this.evidence, this.#candidate, this.#feedback, this.#issues, this.#lastAttempt, !!this.#stopReason),
      remaining_repairs: Math.max(0, MAX_REPORT_REPAIRS - this.#failedRepairs),
      remaining_ms: this.#repairDeadline === undefined ? null : Math.max(0, this.#repairDeadline - Date.now()),
      stop_reason: this.#stopReason ?? null };
  }

  canInspectSnapshot(name: unknown): boolean {
    if (typeof name !== "string") return false;
    let normalized: string;
    try { normalized = normalizeDataSnapshotName(name); } catch { return false; }
    return this.#issues.some((issue) => ["LOSS_REFERENCE_MISMATCH", "LOSS_STATE_MISMATCH"].includes(issue.code) &&
      issue.evidence_id !== undefined && this.evidence.get(issue.evidence_id)?.snapshot?.name === normalized);
  }

  /** Permit investigation only when an evidence failure cannot be resolved from the catalogue. */
  needsEvidence(period?: PeriodKey): boolean {
    return this.modelContext().repair_plan.evidence_actions.some((action) =>
      (!period || action.period === period) && (action.action === "query" || action.action === "investigate"));
  }

  #rejectStructure(error: unknown): void {
    if (error instanceof AnalysisValidationError) { this.#reject(error.issues, this.#lastAttempt.target, error.has_more); return; }
    this.#reject([{ code: "STRUCTURE_INVALID", path: "/", expected: "合法结构化报告或组", actual: "结构无效",
      message: error instanceof Error ? error.message : String(error), hint: "修正字段结构，不要将整个报告转成字符串。" }]);
  }

  #reject(issues: readonly AnalysisValidationIssue[], target?: RepairTarget, hasMore = false): void {
    this.#feedback = issues;
    this.#hasMore = hasMore;
    const current = fingerprint(issues);
    // An untouched failing group must not stop a successful repair of another group.
    const attempted = target ? fingerprint(issues.filter((issue) => issue.period === target.period && issue.kind === target.kind)) : current;
    const repeated = [...attempted].some((entry) => this.#previousFingerprints.has(entry));
    this.#previousFingerprints = current;
    // A successfully repaired group leaves other groups pending; that is progress, not a failed repair.
    if (this.active && (!target || attempted.size > 0)) this.#failedRepairs += 1;
    this.#failures += 1;
    this.#repairDeadline ??= Math.min(Date.now() + REPORT_REPAIR_TIMEOUT_MS, this.deadline - ANALYSIS_CLEANUP_RESERVE_MS);
    if (repeated) this.stop("同一校验错误连续出现两次");
    else if (this.#failedRepairs >= MAX_REPORT_REPAIRS) this.stop("已用尽三次失败修正额度");
    else if (Date.now() >= this.#repairDeadline) this.stop("报告修正时间预算已耗尽");
    this.onEvent({ type: "analysis_validation_failed", attempt: this.#failures, issues, has_more: this.#hasMore,
      repair_plan: this.modelContext().repair_plan,
      repair_deadline: this.#repairDeadline, stop_reason: this.#stopReason ?? null });
  }
}
