import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { normalizeDataSnapshotName } from "../../../tool/artifact-store.ts";
import type { CodeInterpreterRuntime } from "../../../tool/code-interpreter.ts";
import { createAgentTools, createExecuteSqlTool, executeSqlParameters } from "../../../tool/database-tools.ts";
import { createMeasureLossTool, measureLossParameters, MEASURE_LOSS_TOOL_NAME } from "../../../tool/loss-tools.ts";
import type { AnalysisEvidence, AnalysisEvidenceScope, Evidence, EvidenceOwner } from "./evidence.ts";
import { PERIOD_KEYS, type PeriodKey } from "../periods.ts";
import { PeriodKeySchema } from "./report.ts";

/** Full rows stay on disk and in the audit registry, not in model messages. */
export function evidenceOutput(record: Evidence) {
  const preview = [];
  let bytes = 0;
  for (const [row_index, row] of record.rows.slice(0, 3).entries()) {
    bytes += Buffer.byteLength(JSON.stringify(row));
    if (bytes > 6000) break;
    preview.push({ row_index, row });
  }
  const details = {
    evidence_id: record.id, range: record.range, source: record.source, owner: record.owner,
    snapshot: record.snapshot ?? null, row_count: record.rows.length, truncated: record.truncated,
    preview: { rows: preview, truncated: preview.length < record.rows.length },
    pythonInput: { rows: "snapshot_rows", rowShape: "list[dict]", rowAccess: "row['column_name']",
      row_index: "Use enumerate(snapshot_rows) BEFORE sorting/filtering to preserve evidence row indices." },
  };
  return { content: [{ type: "text" as const, text: JSON.stringify(details) }], details };
}

export function createAnalysisTools(evidence: AnalysisEvidence, interpreter: CodeInterpreterRuntime, scope?: AnalysisEvidenceScope) {
  const sharedArtifacts = evidence.artifacts;
  if (!sharedArtifacts) throw new Error("每日分析需要独立的数据快照存储");
  const ownerFor = (params: object): EvidenceOwner => {
    if (scope) {
      if ("period" in params) throw new Error("子任务周期由服务端绑定，不能指定 period");
      return { period: scope.period, agentId: scope.agentId };
    }
    const period = "period" in params ? params.period : undefined;
    if (!PERIOD_KEYS.includes(period as PeriodKey)) throw new Error("每日补查必须指定 period：week、month 或 quarter");
    return { period: period as PeriodKey, agentId: "root" };
  };
  const storeFor = (owner: EvidenceOwner) => sharedArtifacts.scoped(owner.agentId + "/" + owner.period);
  const sqlParameters = scope
    ? Type.Object(executeSqlParameters.properties, { additionalProperties: false })
    : Type.Object({ ...executeSqlParameters.properties, period: PeriodKeySchema }, { additionalProperties: false });
  const lossParameters = scope
    ? Type.Object(measureLossParameters.properties, { additionalProperties: false })
    : Type.Object({ ...measureLossParameters.properties, period: PeriodKeySchema }, { additionalProperties: false });
  const tool = createExecuteSqlTool(evidence.queries, sharedArtifacts);
  const loss = createMeasureLossTool(evidence.queries, sharedArtifacts);
  const auxiliary = createAgentTools(evidence.queries, sharedArtifacts, interpreter, new Set(), undefined, !!scope)
    .filter((entry) => entry.name !== "execute_sql" && entry.name !== MEASURE_LOSS_TOOL_NAME)
    .map((entry) => !scope || entry.name !== "code_interpreter" ? entry : defineTool({
      ...entry,
      async execute(id, params, signal, update, ctx) {
        if (params && typeof params === "object" && "snapshot" in params && typeof params.snapshot === "string") {
          evidence.assertSnapshotAccess(params.snapshot, scope);
        }
        return entry.execute(id, params, signal, update, ctx);
      },
    }));
  return [
    ...auxiliary,
    defineTool({ ...loss, parameters: lossParameters,
      description: loss.description + (scope ? " Evidence is private to the assigned period and task." : " period is required and assigns the evidence to one report period."),
      execute: (id, params, signal, update, ctx) => {
        const owner = ownerFor(params);
        const scopedLoss = createMeasureLossTool(evidence.queries, storeFor(owner), (measurement) => evidence.recordLoss(measurement, owner).id);
        return evidence.withEvidenceWrite(() => scopedLoss.execute(id, params, signal, update, ctx), signal);
      },
    }),
    defineTool({
      ...tool,
      parameters: sqlParameters,
      description: tool.description + " Daily analysis always saves the complete result as an immutable evidence snapshot, even when save_as is omitted. Returns an evidence_id and at most 3 preview rows. Existing evidence names cannot be replaced; use a new save_as name. Names beginning evidence- are reserved. All queries share the dashboard read transaction." + (scope ? " Evidence is private to the assigned period and task." : " period is required and assigns the evidence to one report period."),
      async execute(id, params, signal, onUpdate, ctx) {
        const owner = ownerFor(params);
        const artifacts = storeFor(owner);
        const scopedSql = createExecuteSqlTool(evidence.queries, artifacts);
        return evidence.withEvidenceWrite(async () => {
          const name = normalizeDataSnapshotName(params.save_as ?? "query-" + (evidence.records.size + 1));
          const canonicalName = artifacts.snapshotName(name);
          if (name.startsWith("evidence-") || name.startsWith("sa-") || [...evidence.records.values()].some((record) =>
            record.snapshot?.name === canonicalName || record.snapshot?.name === name)) {
            throw new Error("快照名称已固定为审计证据或属于保留名称，请使用新的 save_as 名称");
          }
          await scopedSql.execute(id, { ...params, save_as: name, limit: Math.min(params.limit ?? 3, 3) }, signal, onUpdate, ctx);
          return evidenceOutput(evidence.recordSnapshot(params.sql, params.parameters ?? [], canonicalName, owner));
        }, signal);
      },
    }),
  ];
}
