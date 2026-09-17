import { randomUUID } from "node:crypto";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import { AnalysisGroupSchema, AnalysisItemSchema, AnalysisKindSchema, PeriodKeySchema,
  decodeAnalysisStructures, validateAnalysisReport, type AnalysisReport } from "./report.ts";
import type { AnalysisContext, Evidence } from "./evidence.ts";

const target = { period: PeriodKeySchema, kind: AnalysisKindSchema };
export const FinalizeAnalysisSchema = Type.Object({
  draft_id: Type.String({ minLength: 1 }),
  verification: Type.String({ minLength: 1, maxLength: 5000 }),
  updates: Type.Array(Type.Union([
    Type.Object({ op: Type.Literal("update_period"), period: PeriodKeySchema,
      comparison: Type.String({ minLength: 1, maxLength: 1800 }) }, { additionalProperties: false }),
    Type.Object({ op: Type.Literal("update_item"), ...target, priority: Type.Integer({ minimum: 1, maximum: 3 }),
      changes: Type.Partial(Type.Omit(AnalysisItemSchema, ["priority"]), { minProperties: 1, additionalProperties: false }) },
    { additionalProperties: false }),
    Type.Object({ op: Type.Literal("replace_group"), ...target, group: Type.Omit(AnalysisGroupSchema, ["kind"]) },
      { additionalProperties: false }),
  ]), { maxItems: 27 }),
}, { additionalProperties: false });
export const GetAnalysisDraftSchema = Type.Object({
  draft_id: Type.String({ minLength: 1 }), period: Type.Optional(PeriodKeySchema), kind: Type.Optional(AnalysisKindSchema),
}, { additionalProperties: false });
export type FinalizeAnalysis = Static<typeof FinalizeAnalysisSchema>;

export function parseFinalizeAnalysis(input: unknown): FinalizeAnalysis {
  const value = decodeAnalysisStructures(input);
  if (!Value.Check(FinalizeAnalysisSchema, value)) {
    const first = [...Value.Errors(FinalizeAnalysisSchema, value)][0];
    throw new Error("复核提交字段无效：" + first?.instancePath + " " + first?.message +
      "；使用 draft_id、verification 和 updates 数组；无修改时 updates=[]");
  }
  if (!value.verification.trim()) throw new Error("verification 必须说明复核结果");
  return value;
}

/** A draft is never changed by a failed or successful finalize operation. */
export class AnalysisDrafts {
  #draft: { id: string; turn: number; report: AnalysisReport } | undefined;
  readonly #context: AnalysisContext;
  readonly #evidence: ReadonlyMap<string, Evidence>;

  constructor(context: AnalysisContext, evidence: ReadonlyMap<string, Evidence>) {
    this.#context = context;
    this.#evidence = evidence;
  }

  get id(): string | null { return this.#draft?.id ?? null; }

  submit(input: unknown, turn: number) {
    const { report } = validateAnalysisReport(input, this.#context, this.#evidence);
    this.#draft = { id: randomUUID(), turn, report: structuredClone(report) };
    return { draft_id: this.#draft.id, report: structuredClone(report) };
  }

  #current(id: string) {
    if (!this.#draft) throw new Error("尚无有效草稿，请先调用 submit_analysis");
    if (id !== this.#draft.id) throw new Error("草稿 ID 已过期或不存在；当前 draft_id=" + this.#draft.id);
    return this.#draft;
  }

  get(params: Static<typeof GetAnalysisDraftSchema>) {
    const draft = this.#current(params.draft_id);
    return { draft_id: draft.id, report: { ...structuredClone(draft.report),
      periods: structuredClone(draft.report.periods.filter((period) => !params.period || period.period === params.period)
        .map((period) => ({ ...period, groups: period.groups.filter((group) => !params.kind || group.kind === params.kind) }))),
    } };
  }

  finalize(input: unknown, turn: number) {
    const params = parseFinalizeAnalysis(input);
    const draft = this.#current(params.draft_id);
    if (turn <= draft.turn) throw new Error("须在收到草稿复核要求之后的模型轮次调用 finalize_analysis");
    const report = structuredClone(draft.report);
    const targets = new Set<string>();
    const replacements = new Set<string>();
    const itemGroups = new Set<string>();
    for (const update of params.updates) {
      const groupKey = update.op === "update_period" ? update.period : update.period + "/" + update.kind;
      const key = update.op + "/" + groupKey + (update.op === "update_item" ? "/" + update.priority : "");
      if (targets.has(key)) throw new Error("重复修改目标：" + key);
      targets.add(key);
      if (update.op === "replace_group") replacements.add(groupKey);
      if (update.op === "update_item") itemGroups.add(groupKey);
    }
    if ([...replacements].some((key) => itemGroups.has(key))) throw new Error("不能同时替换分组和修改该组条目");
    for (const update of params.updates) {
      const period = report.periods.find((entry) => entry.period === update.period)!;
      if (update.op === "update_period") { period.comparison = update.comparison; continue; }
      const group = period.groups.find((entry) => entry.kind === update.kind)!;
      if (update.op === "replace_group") { Object.assign(group, update.group); continue; }
      const item = group.items.find((entry) => entry.priority === update.priority);
      if (!item) throw new Error("条目不存在：" + update.period + "/" + update.kind + "/" + update.priority);
      Object.assign(item, update.changes);
    }
    report.verification = params.verification;
    return validateAnalysisReport(report, this.#context, this.#evidence);
  }
}
