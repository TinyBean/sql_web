import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import type { AnalysisContext, Evidence } from "./evidence.ts";
import type { PeriodKey } from "../periods.ts";
import { normalizeDataSnapshotName } from "../../../tool/artifact-store.ts";
import {
  ANALYSIS_CATEGORY_METRICS, AnalysisGroupSchema, AnalysisItemSchema, AnalysisKindSchema, PeriodKeySchema,
  AnalysisValidationError, decodeAnalysisStructures, degradeAnalysisReport, parseAnalysisReport, validateAnalysisReport,
  type AnalysisReport, type AnalysisResult, type AnalysisValidationIssue,
} from "./report.ts";

export const MAX_REPORT_REPAIRS = 3;
export const REPORT_REPAIR_TIMEOUT_MS = 120_000;
export const ANALYSIS_CLEANUP_RESERVE_MS = 10_000;

export const RepairAnalysisGroupSchema = Type.Object({
  period: PeriodKeySchema, kind: AnalysisKindSchema, group: AnalysisGroupSchema,
  omitted_candidates: Type.Optional(Type.Array(Type.Object({
    item: AnalysisItemSchema, reason: Type.String({ minLength: 1, maxLength: 1800 }),
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
    try { return parseAnalysisReport(input); }
    catch (error) { this.#rejectStructure(error); throw error; }
  }

  prepareGroup(input: unknown): Static<typeof RepairAnalysisGroupSchema> {
    try {
      const decoded = decodeAnalysisStructures(input);
      if (!Value.Check(RepairAnalysisGroupSchema, decoded)) {
        const first = [...Value.Errors(RepairAnalysisGroupSchema, decoded)][0];
        throw new AnalysisValidationError([{ code: "STRUCTURE_INVALID", path: first?.instancePath || "/",
          expected: "合法局部修正字段结构", actual: "结构无效",
          message: "局部修正字段或结构无效：" + (first?.message ?? "缺少周期、类型和建议组"),
          hint: "只修正定位字段，保留其他组；group 必须是结构化对象。" }]);
      }
      return decoded;
    } catch (error) { this.#rejectStructure(error); throw error; }
  }

  submit(candidate: AnalysisReport, target?: { period: PeriodKey; kind: "MT" | "ST" }): AnalysisResult | undefined {
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
    const invalid = !this.#candidate ? "尚无结构合法的完整候选，请先调用 submit_analysis。" :
      params.group.kind !== params.kind ? "group.kind 必须与待修正的 kind 一致。" :
      !this.#issues.some((issue) => issue.period === params.period && issue.kind === params.kind) ? "只能修正当前校验指出的周期和类型。" : null;
    if (invalid) {
      this.#reject([{ code: "REPAIR_TARGET_INVALID", path: "/group", period: params.period, kind: params.kind,
        expected: "校验指出的周期类型组", actual: "无效目标组", message: invalid, hint: "使用 analysis_repair.pending_groups 指定的组。" }]);
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
    return { active: this.active, issues: this.#feedback, pending_groups: groups,
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
    return this.#issues.some((issue) => {
      if (period && issue.period !== period) return false;
      if (!/^(EVIDENCE_|RANKING_(SOURCE|RANGE|KIND|BASIS)_|LOSS_(REFERENCE|STATE)_)/u.test(issue.code)) return false;
      if (!issue.period || !issue.kind || issue.item_index === undefined || !this.#candidate) return true;
      const item = this.#candidate.periods.find((entry) => entry.period === issue.period)?.groups
        .find((group) => group.kind === issue.kind)?.items[issue.item_index];
      if (!item) return true;
      const range = this.context.periods[issue.period];
      const scoped = [...this.evidence.values()].filter((record) => !record.truncated && record.owner?.period === issue.period &&
        record.range?.start === range.start && record.range.end === range.end);
      if (issue.code !== "LOSS_STATE_MISMATCH" && (issue.code === "LOSS_REFERENCE_MISMATCH" ||
          issue.path.includes("loss_reference") || item.loss_reference?.evidence_id === issue.evidence_id)) {
        return !scoped.some((record) => record.source === "measure_loss" && record.rows.some((row) => row["kind"] === issue.kind && typeof row["loss_hours"] === "number"));
      }
      if (issue.path.includes("machine_evidence_ids") || issue.code === "LOSS_STATE_MISMATCH" || item.machine_evidence_ids.includes(issue.evidence_id ?? "")) {
        return !scoped.some((record) => record.source === "rank_machines" && record.rankingScope && record.rankingScope.kind === issue.kind &&
          record.rankingScope.basis === "report_period" &&
          (ANALYSIS_CATEGORY_METRICS[item.category] as readonly string[]).includes(record.rankingScope.metric) &&
          record.rows.every((row) => row["kind"] === issue.kind) &&
          (issue.code !== "LOSS_STATE_MISMATCH" || !record.rankingScope.states.length || record.rankingScope.states.includes(String(issue.expected))));
      }
      return true;
    });
  }

  #rejectStructure(error: unknown): void {
    if (error instanceof AnalysisValidationError) { this.#reject(error.issues); return; }
    this.#reject([{ code: "STRUCTURE_INVALID", path: "/", expected: "合法结构化报告或组", actual: "结构无效",
      message: error instanceof Error ? error.message : String(error), hint: "修正字段结构，不要将整个报告转成字符串。" }]);
  }

  #reject(issues: readonly AnalysisValidationIssue[], target?: { period: PeriodKey; kind: "MT" | "ST" }): void {
    this.#feedback = issues;
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
    this.onEvent({ type: "analysis_validation_failed", attempt: this.#failures, issues,
      repair_deadline: this.#repairDeadline, stop_reason: this.#stopReason ?? null });
  }
}
