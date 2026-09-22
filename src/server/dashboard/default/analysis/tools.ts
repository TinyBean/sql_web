import { defineTool } from "@earendil-works/pi-coding-agent";
import { normalizeDataSnapshotName } from "../../../tool/artifact-store.ts";
import type { CodeInterpreterRuntime } from "../../../tool/code-interpreter.ts";
import { createAgentTools, createExecuteSqlTool, executeSqlParameters } from "../../../tool/database-tools.ts";
import { createMeasureLossTool, MEASURE_LOSS_TOOL_NAME } from "../../../tool/loss-tools.ts";
import type { AnalysisEvidence, Evidence } from "./evidence.ts";

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
    evidence_id: record.id, range: record.range, source: record.source,
    snapshot: record.snapshot ?? null, row_count: record.rows.length, truncated: record.truncated,
    preview: { rows: preview, truncated: preview.length < record.rows.length },
    pythonInput: { rows: "snapshot_rows", rowShape: "list[dict]", rowAccess: "row['column_name']",
      row_index: "Use enumerate(snapshot_rows) BEFORE sorting/filtering to preserve evidence row indices." },
  };
  return { content: [{ type: "text" as const, text: JSON.stringify(details) }], details };
}

export function createAnalysisTools(evidence: AnalysisEvidence, interpreter: CodeInterpreterRuntime) {
  const artifacts = evidence.artifacts;
  if (!artifacts) throw new Error("每日分析需要独立的数据快照存储");
  const tool = createExecuteSqlTool(evidence.queries, artifacts);
  return [
    ...createAgentTools(evidence.queries, artifacts, interpreter).filter((entry) => entry.name !== "execute_sql" && entry.name !== MEASURE_LOSS_TOOL_NAME),
    createMeasureLossTool(evidence.queries, artifacts, (measurement) => evidence.recordLoss(measurement).id),
    defineTool<typeof executeSqlParameters, ReturnType<typeof evidenceOutput>["details"]>({
      ...tool,
      parameters: executeSqlParameters,
      description: tool.description + " Daily analysis always saves the complete result as an immutable evidence snapshot, even when save_as is omitted. Returns an evidence_id and at most 3 preview rows. Existing evidence names cannot be replaced; use a new save_as name. Names beginning evidence- are reserved. All queries share the dashboard read transaction.",
      async execute(id, params, signal, onUpdate, ctx) {
        const name = normalizeDataSnapshotName(params.save_as ?? "query-" + (evidence.records.size + 1));
        if (name.startsWith("evidence-") || [...evidence.records.values()].some((record) => record.snapshot?.name === name)) {
          throw new Error("快照名称已固定为审计证据或属于保留名称，请使用新的 save_as 名称");
        }
        await tool.execute(id, { ...params, save_as: name, limit: Math.min(params.limit ?? 3, 3) }, signal, onUpdate, ctx);
        return evidenceOutput(evidence.recordSnapshot(params.sql, params.parameters ?? [], name));
      },
    }),
  ];
}
