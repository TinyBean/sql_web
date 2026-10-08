import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import { parseDashboardState, type DashboardRow, type DashboardState } from "../../../../shared/dashboard.ts";
import { type AnalysisContext, type Evidence } from "./evidence.ts";
import { ANALYSIS_PERIOD_KEYS, type PeriodKey } from "../periods.ts";
import { createAnalysisTemplate } from "../template.ts";
import { formatMachineMentions, hasMachineDistributionClaim } from "../../../skills/test-oee-calculator/assets/machine-platforms.ts";
import { machineRankingView, type MachineMetric } from "../../../skills/test-oee-calculator/assets/machine-ranking.ts";

const ANALYSIS_KEYS = new Map(ANALYSIS_PERIOD_KEYS.map((key) => [createAnalysisTemplate(key).id, key]));

const readableDescription = "面向业务用户的中文说明，用实际日期、指标和数据来源解释结论，不含 q11 等内部证据编号、查询行号、工具名或字段名。";
const text = Type.String({ minLength: 1, maxLength: 1800, description: readableDescription });
const refs = Type.Array(Type.String({ minLength: 1 }), { minItems: 1, maxItems: 12 });
export const ANALYSIS_CATEGORY_METRICS = {
  availability: ["loss_hours", "availability", "effective_availability"],
  performance: ["dut_on", "test_time_performance"], yield: ["final_yield"],
  other: ["loss_hours", "availability", "effective_availability", "dut_on", "test_time_performance", "final_yield", "oee", "effective_oee"],
} as const satisfies Record<string, readonly MachineMetric[]>;
export const ANALYSIS_CATEGORY_RULES = Object.entries(ANALYSIS_CATEGORY_METRICS)
  .map(([category, metrics]) => category + " 允许 " + metrics.join("、")).join("；") +
  "。Performance 与 Yield 必须分别提交；同类别可以引用多个指标，不能用 other 合并 Performance/Yield。拆分后按影响、证据充分程度和改善价值重新选前三条，不折算损失小时。";
export const PeriodKeySchema = Type.Union([Type.Literal("day"), Type.Literal("week"), Type.Literal("month"), Type.Literal("quarter")]);
export const AnalysisKindSchema = Type.Union([Type.Literal("MT"), Type.Literal("ST")]);
export const AnalysisItemSchema = Type.Object({
  priority: Type.Integer({ minimum: 1, maximum: 3 }),
  category: Type.Union([Type.Literal("availability"), Type.Literal("performance"), Type.Literal("yield"), Type.Literal("other")], { description: ANALYSIS_CATEGORY_RULES }),
  issue: text, measure: text,
  suggested_owner: Type.String({ minLength: 1, maxLength: 160, description: readableDescription }),
  evidence_ids: refs,
  machine_evidence_ids: refs,
  loss_reference: Type.Union([Type.Null(), Type.Object({ evidence_id: Type.String(), row_index: Type.Integer({ minimum: 0 }) }, { additionalProperties: false })]),
}, { additionalProperties: false });
export const AnalysisGroupSchema = Type.Object({
  kind: AnalysisKindSchema,
  no_findings_reason: Type.String({ maxLength: 1800, description: readableDescription }),
  evidence_ids: refs,
  items: Type.Array(AnalysisItemSchema, { maxItems: 3 }),
}, { additionalProperties: false });
export const AnalysisReportSchema = Type.Object({
  periods: Type.Array(Type.Object({
    period: PeriodKeySchema, comparison: text,
    minimum_evidence: Type.String(), history_evidence: Type.String(),
    groups: Type.Array(AnalysisGroupSchema, { minItems: 2, maxItems: 2 }),
  }, { additionalProperties: false }), { minItems: 4, maxItems: 4 }),
}, { additionalProperties: false });

export type AnalysisReport = Static<typeof AnalysisReportSchema>;
export type AnalysisGroup = Static<typeof AnalysisGroupSchema>;

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
}

export class AnalysisValidationError extends Error {
  readonly issues: readonly AnalysisValidationIssue[];
  constructor(issues: readonly AnalysisValidationIssue[]) {
    super(issues.map((issue) => [issue.period, issue.kind, issue.priority === undefined ? "" : "第" + issue.priority + "条", issue.path,
      issue.evidence_id, issue.message, "预期=" + JSON.stringify(issue.expected), "实际=" + JSON.stringify(issue.actual), issue.hint]
      .filter(Boolean).join(" / ")).join("\n"));
    this.name = "AnalysisValidationError";
    this.issues = issues;
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

export const ANALYSIS_PERIOD_NAMES: Record<PeriodKey, string> = { day: "日", week: "周", month: "月", quarter: "季度" };
export function analysisExclusionSummary(exclusions: readonly Pick<AnalysisExclusion, "period" | "kind">[]): string {
  const counts = new Map<string, number>();
  for (const entry of exclusions) {
    const label = ANALYSIS_PERIOD_NAMES[entry.period] + " " + entry.kind;
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  return "报告降级：" + [...counts].map(([label, count]) => label + " 剔除 " + count + " 条未通过证据校验的建议").join("；");
}

/** Decode only structural fields; never guess repairs or echo report contents. */
export function decodeAnalysisStructures(value: unknown): unknown {
  const structural = new Set(["periods", "groups", "group", "items", "evidence_ids", "machine_evidence_ids", "loss_reference", "omitted_candidates"]);
  const decode = (input: unknown, key = "", location = ""): unknown => {
    if (structural.has(key) && typeof input === "string") {
      try { input = JSON.parse(input) as unknown; }
      catch (error) {
        const position = error instanceof Error ? error.message.match(/position \d+|line \d+ column \d+/gu)?.join("; ") : undefined;
        throw new AnalysisValidationError([{ code: "STRUCTURE_INVALID", path: location || "/",
          expected: "数组/对象或合法的 JSON 字符串", actual: "无效 JSON 字符串",
          message: "结构字段不是合法的 JSON" + (position ? "（" + position + "）" : ""),
          hint: "直接传结构化数组/对象，修正该字段，不要将整个报告转成字符串。" }]);
      }
    }
    if (Array.isArray(input)) return input.map((entry, index) => decode(entry, "", location + "/" + index));
    if (input && typeof input === "object") {
      return Object.fromEntries(Object.entries(input).map(([name, entry]) => [name, decode(entry, name,
        location + "/" + name.replaceAll("~", "~0").replaceAll("/", "~1"))]));
    }
    return input;
  };
  return decode(value);
}

export function parseAnalysisReport(value: unknown): AnalysisReport {
  const decoded = decodeAnalysisStructures(value);
  if (!Value.Check(AnalysisReportSchema, decoded)) {
    const first = [...Value.Errors(AnalysisReportSchema, decoded)][0];
    throw new AnalysisValidationError([{ code: "STRUCTURE_INVALID", path: first?.instancePath || "/",
      expected: "合法报告字段结构", actual: "结构无效",
      message: "报告字段或结构无效：" + (first?.message ?? "缺少完整四期和 MT/ST 分组"),
      hint: "修正定位字段结构；提交完整四期（日/周/月/季）、每期 MT/ST 两组。" }]);
  }
  return decoded;
}

function assertReadableText(value: string, field: string): void {
  // Keep business identifiers such as Q1, W36, ADH075 and MT/ST intact.
  const internalReference = /(?<![A-Za-z0-9_])q\d+(?![A-Za-z0-9_])|第\s*\d+\s*行|\b(?:row\s*\d+|measure_loss|test_oee_calculator__rank_machines|rank_machines|execute_sql|submit_analysis|repair_analysis_group|finalize_analysis|get_analysis_draft|draft_id|evidence_ids?|machine_evidence_ids|loss_reference|minimum_evidence|history_evidence|row_index|by_machine|hours_per_kind_available_day|hours_per_selected_day|kind_availability_days|observed_days|selected_days|calculable_days|availability_days|dut_days|daily_test_oee|final_yield|state_group|loss_hours)\b/u;
  if (internalReference.test(value)) {
    throw new Error(field + " 含内部证据编号、查询行号、工具名或字段名。请改写为业务用户可理解的日期、指标和数据来源（如‘本周损失统计’‘当季机台明细’‘每个有数据业务日的平均损失小时’），保留事实、数值和统计口径；内部引用仅放在 evidence_ids、minimum_evidence、history_evidence、loss_reference 等结构化字段中。");
  }
}

export function validateAnalysisReport(
  input: unknown, context: AnalysisContext, evidence: ReadonlyMap<string, Evidence>,
): AnalysisResult {
  const value = parseAnalysisReport(input);
  const issues: AnalysisValidationIssue[] = [];
  const rows = {} as Record<PeriodKey, DashboardRow[]>;
  const renderedItems = new Map<AnalysisGroup["items"][number], string>();
  const renderedComparisons = new Map<AnalysisReport["periods"][number], string>();
  type Location = Pick<AnalysisValidationIssue, "period" | "kind" | "priority" | "item_index">;
  const add = (location: Location, path: string, code: string, message: string, expected: unknown, actual: unknown,
    hint = "只修正定位字段，保留已核实的其他内容。", evidence_id?: string): void => {
    issues.push({ ...location, path, code, message, expected, actual, hint, ...(evidence_id ? { evidence_id } : {}) });
  };
  const readable = (text: string, location: Location, path: string): void => {
    try { assertReadableText(text, path); }
    catch (error) { add(location, path, "UNREADABLE_TEXT", (error as Error).message, "业务可读中文", "含内部标记", "保留事实与口径，改写正文；内部编号只放在结构化引用字段。"); }
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
  for (const key of ANALYSIS_PERIOD_KEYS) {
    const matching = value.periods.map((report, index) => ({ report, index })).filter(({ report }) => report.period === key);
    if (matching.length !== 1) {
      add({ period: key }, "/periods", "PERIOD_COVERAGE", "每个周期必须且只能提交一次", 1, matching.length); continue;
    }
    const { report, index: periodIndex } = matching[0]!;
    const periodPath = "/periods/" + periodIndex;
    const periodLocation = { period: key };
    readable(report.comparison, periodLocation, periodPath + "/comparison");
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
      readable(group.no_findings_reason, groupLocation, groupPath + "/no_findings_reason");
      if (!group.items.length && hasMachineDistributionClaim(group.no_findings_reason)) {
        add(groupLocation, groupPath + "/no_findings_reason", "UNVERIFIED_DISTRIBUTION", "无建议原因不能包含未经机台排名证据核实的集中或分散结论", "数据不足或无充分依据的说明", "机台分布结论");
      }
      refs(group.evidence_ids, groupLocation, groupPath + "/evidence_ids");
      if (!group.evidence_ids.includes(expected.current.id)) add(groupLocation, groupPath + "/evidence_ids", "CURRENT_EVIDENCE_MISSING", "缺少本期指标证据", expected.current.id, group.evidence_ids);
      if (!group.items.length && !group.no_findings_reason.trim()) add(groupLocation, groupPath + "/no_findings_reason", "EMPTY_GROUP_REASON", "空清单必须解释数据不足或无充分依据的原因", "非空说明", "");
      const ordered = [...group.items].sort((a, b) => a.priority - b.priority);
      for (const [itemIndex, item] of group.items.entries()) {
        const itemPath = groupPath + "/items/" + itemIndex;
        const location = { ...groupLocation, priority: item.priority, item_index: itemIndex };
        const itemIssueStart = issues.length;
        if (item.priority !== ordered.indexOf(item) + 1) add(location, itemPath + "/priority", "PRIORITY_SEQUENCE", "同周期同类型优先级必须由 1 连续排列且不重复", ordered.indexOf(item) + 1, item.priority);
        for (const field of ["issue", "measure", "suggested_owner"] as const) {
          if (!item[field].trim()) add(location, itemPath + "/" + field, "EMPTY_TEXT", "问题、措施、责任职能不能为空", "非空正文", "");
          readable(item[field], location, itemPath + "/" + field);
        }
        refs(item.evidence_ids, location, itemPath + "/evidence_ids");
        const forbiddenHours = item.loss_reference !== null && (item.category === "performance" || item.category === "yield");
        if (forbiddenHours) add(location, itemPath + "/loss_reference", "RATIO_LOSS_REFERENCE", "Performance/Yield 不得折算为损失小时，loss_reference 应为 null", null, item.loss_reference);
        const rankings: { record: Evidence; summary: string }[] = [];
        const metrics = new Set<MachineMetric>();
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
          metrics.add(scope.metric);
          if (ranking.range?.start !== context.periods[key].start || ranking.range.end !== context.periods[key].end) add(location, rankingPath, "RANKING_RANGE_MISMATCH", "TOP3 日期范围不匹配本期", context.periods[key], ranking.range ?? null, "复用本周期完整日期范围的排名。", id);
          if (scope.kind !== kind || ranking.rows.some((row) => row["kind"] !== kind)) add(location, rankingPath, "RANKING_KIND_MISMATCH", "TOP3 必须引用同类型机台排名", kind, { scope: scope.kind, rows: [...new Set(ranking.rows.map((row) => row["kind"]))] }, "复用同 MT/ST 的排名。", id);
          if (scope.basis !== "report_period") add(location, rankingPath, "RANKING_BASIS_MISMATCH", "TOP3 必须引用完整整期排名证据", "report_period", scope.basis, "固定报告使用 report_period，不使用 machine_day。", id);
          if (!(ANALYSIS_CATEGORY_METRICS[item.category] as readonly MachineMetric[]).includes(scope.metric)) add(location, rankingPath, "METRIC_CATEGORY_MISMATCH", "TOP3 问题类别与排名指标不匹配", ANALYSIS_CATEGORY_METRICS[item.category], { category: item.category, metric: scope.metric }, "Performance 与 Yield 拆分提交，复用已有对应排名；拆分后重新选前三条。", id);
          if (issues.length === rankingIssueStart && !rankings.some(({ record }) => record.id === id)) rankings.push({ record: ranking, summary: machineRankingView({ rows: ranking.rows, range: ranking.range!, scope }).summary });
        }
        if (item.category === "other" && metrics.has("final_yield") &&
          (metrics.has("dut_on") || metrics.has("test_time_performance"))) add(location, itemPath + "/category", "MIXED_PERFORMANCE_YIELD", "不能用 other 合并 Performance/Yield", "分别提交 performance 和 yield", [...metrics], "拆分 Socket/测试时间与良率建议，分别引用对应排名。");
        let hours: number | null = null;
        if (item.loss_reference !== null && !forbiddenHours) {
          const reference = item.loss_reference;
          const lossPath = itemPath + "/loss_reference";
          const measured = ref(reference.evidence_id, location, lossPath + "/evidence_id");
          if (measured) {
            const row = measured.rows[reference.row_index];
            const validLoss = item.evidence_ids.includes(measured.id) && measured.source === "measure_loss" &&
              measured.range?.start === context.periods[key].start && measured.range.end === context.periods[key].end &&
              row?.["kind"] === kind && typeof row["loss_hours"] === "number";
            if (!validLoss) add(location, lossPath, "LOSS_REFERENCE_MISMATCH", "损失小时必须引用 measure_loss 返回的本期同类型实测行", { source: "measure_loss", range: context.periods[key], kind, numeric_loss_hours: true },
              { source: measured.source ?? null, range: measured.range ?? null, row: row ?? null, included: item.evidence_ids.includes(measured.id) }, "保留原始行号，复用本期同类型的标准实测损失证据。", measured.id);
            else {
              // Invalid ranking references already explain the failure; do not cascade a state error.
              if (issues.length === itemIssueStart && !rankings.some(({ record }) => record.rankingScope!.metric === "loss_hours" &&
                (!record.rankingScope!.states.length || record.rankingScope!.states.includes(String(row["state_group"]))))) add(location, itemPath + "/machine_evidence_ids", "LOSS_STATE_MISMATCH", "损失问题的 TOP3 状态范围与实测损失引用不匹配", row["state_group"], rankings.map(({ record }) => record.rankingScope!.states), "引用覆盖该损失状态的已有排名；缺少时补查。", measured.id);
              hours = Math.round((row["loss_hours"] as number) * 10) / 10;
            }
          }
        }
        let authoredIssue = item.issue;
        for (const ranking of rankings) authoredIssue = authoredIssue.replaceAll(ranking.summary, "");
        if (/TOP\s*3/iu.test(authoredIssue) && issues.length === itemIssueStart) add(location, itemPath + "/issue", "AUTHORED_TOP3", "TOP3 文案由服务端生成，请在 issue 中只写事实与判断，通过 machine_evidence_ids 引用排名", "仅事实与判断", "自行编写 TOP3");
        if (issues.length === itemIssueStart && hasMachineDistributionClaim(authoredIssue) && rankings.every(({ record }) =>
          !record.rows.some((row) => typeof row["metric_value"] === "number"))) add(location, itemPath + "/issue", "EMPTY_RANKING_DISTRIBUTION", "机台排名数据不足，不能输出集中或分散结论", "说明数据不足", "机台分布结论");
        if (issues.length !== itemIssueStart) continue;
        const machines = rankings.flatMap(({ record }) => record.rows.map((row) => String(row["machine"])));
        const issue = [formatMachineMentions(item.issue, machines), ...rankings.map(({ summary }) => summary).filter((summary) => !item.issue.includes(summary))].join("\n");
        if (issue.length > 1800) { add(location, itemPath + "/issue", "ISSUE_TOO_LONG", "问题正文与 TOP3 合计超过 1800 字，请压缩问题描述或拆分问题", 1800, issue.length); continue; }
        renderedItems.set(item, issue);
        for (const { summary } of rankings) periodSummaries.add(summary);
        rows[key].push({ kind, priority: item.priority, issue, measure: formatMachineMentions(item.measure, machines),
          suggested_owner: formatMachineMentions(item.suggested_owner, machines) + "（职能建议，待人工确认）", loss_hours: hours });
      }
      rows[key].sort((a, b) => String(a["kind"]).localeCompare(String(b["kind"])) || Number(a["priority"]) - Number(b["priority"]));
    }
    let comparison = formatMachineMentions(report.comparison);
    if (hasMachineDistributionClaim(comparison)) {
      // Only diagnose comparison dependencies once all item references are valid.
      if (!issues.some((issue) => issue.period === key && issue.item_index !== undefined)) {
        if (!periodSummaries.size) add(periodLocation, periodPath + "/comparison", "COMPARISON_DISTRIBUTION", "周期比较中的机台分布结论缺少排名证据", "本周期排名证据", "无排名证据");
        comparison = [comparison, ...[...periodSummaries].filter((summary) => !comparison.includes(summary))].join("\n");
        if (comparison.length > 1800) add(periodLocation, periodPath + "/comparison", "COMPARISON_TOO_LONG", "周期比较与 TOP3 超过 1800 字，请将机台分布分析写入对应问题", 1800, comparison.length);
      }
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
        item.issue = renderedItems.get(item)!;
        const row = rows[period.period].find((row) => row["kind"] === group.kind && row["priority"] === item.priority)!;
        item.measure = String(row["measure"]);
        item.suggested_owner = String(row["suggested_owner"]).replace(/（职能建议，待人工确认）$/u, "");
      }
    }
  }
  return { report: value, rows, status: "completed", exclusions: [] };
}

/** Only item-scoped failures can be discarded; the remaining report must pass the same validator. */
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
      }).sort((a, b) => a.priority - b.priority).map((item, index) => ({ ...item, priority: index + 1 }));
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
