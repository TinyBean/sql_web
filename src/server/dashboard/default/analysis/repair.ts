import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import type { AnalysisContext, Evidence } from "./evidence.ts";
import { ANALYSIS_PERIOD_KEYS, type PeriodKey } from "../periods.ts";
import { normalizeDataSnapshotName } from "../../../tool/artifact-store.ts";
import {
  AnalysisGroupSchema, AnalysisItemSchema, AnalysisKindSchema, PeriodKeySchema,
  AnalysisValidationError, decodeAnalysisStructures, degradeAnalysisReport, parseAnalysisReport, validateAnalysisReport,
  type AnalysisReport, type AnalysisResult, type AnalysisValidationIssue,
} from "./report.ts";
import { analysisRepairPlan, type RepairAttempt, type RepairTarget } from "./feedback.ts";
import { pointerValue, structureIssues } from "./structure.ts";

export const MAX_REPORT_REPAIRS = 3;
export const REPORT_REPAIR_TIMEOUT_MS = 120_000;
export const ANALYSIS_CLEANUP_RESERVE_MS = 10_000;

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
      remaining_repairs: Math.max(0, MAX_REPORT_REPAIRS - Math.max(0, this.#failures - 1)),
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
    this.#failures += 1;
    this.#repairDeadline ??= Math.min(Date.now() + REPORT_REPAIR_TIMEOUT_MS, this.deadline - ANALYSIS_CLEANUP_RESERVE_MS);
    if (repeated) this.stop("同一校验错误连续出现两次");
    else if (this.#failures > MAX_REPORT_REPAIRS) this.stop("已用尽三次报告修正额度");
    else if (Date.now() >= this.#repairDeadline) this.stop("报告修正时间预算已耗尽");
    this.onEvent({ type: "analysis_validation_failed", attempt: this.#failures, issues, has_more: this.#hasMore,
      repair_plan: this.modelContext().repair_plan,
      repair_deadline: this.#repairDeadline, stop_reason: this.#stopReason ?? null });
  }
}
