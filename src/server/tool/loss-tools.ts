import { readFileSync } from "node:fs";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import type { DashboardRow } from "../../shared/dashboard.ts";
import type { AppDatabase, SqlParameter } from "../database/database.ts";
import { assertDate, type DatePeriod } from "../database/business-dates.ts";
import { getTestOeeSqlExpressions } from "../skills/test-oee-calculator/assets/test-oee-calculator.ts";
import { MAX_QUERY_ARTIFACT_BYTES, type DataSnapshotDescriptor, type SessionArtifactStore } from "./artifact-store.ts";
import { lossOutput } from "./loss-output.ts";

export const MEASURE_LOSS_TOOL_NAME = "measure_loss";

export const measureLossParameters = Type.Object({
  start_date: Type.String({ description: "First included business-day label, YYYY-MM-DD." }),
  end_date: Type.String({ description: "Last included business-day label, YYYY-MM-DD." }),
  states: Type.Optional(Type.Array(Type.String(), { maxItems: 40 })),
  machines: Type.Optional(Type.Array(Type.String(), { maxItems: 100 })),
  by_machine: Type.Optional(Type.Boolean()),
});

export interface LossScope {
  readonly states: readonly string[];
  readonly machines: readonly string[];
  readonly byMachine: boolean;
}

export interface LossResult {
  readonly range: DatePeriod;
  readonly scope: LossScope;
  readonly rows: readonly DashboardRow[];
  readonly truncated: boolean;
  readonly snapshot?: DataSnapshotDescriptor;
}

export interface LossMeasurement extends LossResult {
  readonly sql: string;
  readonly parameters: readonly SqlParameter[];
  readonly snapshot: DataSnapshotDescriptor;
  readonly truncated: false;
}

/** Query and freeze one complete measurement on the caller's read connection. */
export function measureLoss(
  database: Pick<AppDatabase, "exportQueryJson">,
  artifacts: SessionArtifactStore,
  params: Static<typeof measureLossParameters>,
  signal?: AbortSignal,
): LossMeasurement {
  signal?.throwIfAborted();
  assertDate(params.start_date);
  assertDate(params.end_date);
  const range = { start: params.start_date, end: params.end_date };
  const e = getTestOeeSqlExpressions("availability", range.start, range.end, "a");
  const scope: LossScope = { states: params.states ?? [], machines: params.machines ?? [], byMachine: params.by_machine ?? false };
  const predicates = ["kind IN ('MT','ST')", "state_group <> 'Machine_Running'"];
  const parameters: SqlParameter[] = [];
  for (const [column, values] of [["state_group", scope.states], ["machine", scope.machines]] as const) {
    if (values.length) {
      predicates.push(column + " IN (" + values.map(() => "?").join(",") + ")");
      parameters.push(...values);
    }
  }
  const selectedDays = (Date.parse(range.end) - Date.parse(range.start)) / 86_400_000 + 1;
  const sql = `WITH facts AS (
    SELECT ${e.dayExpression} AS day, ${e.kindExpression} AS kind,
      ${e.availabilityStateExpression} AS state_group, a.tool_name AS machine,
      CAST(a.time_span AS REAL) AS seconds
    FROM oee_availability a
    WHERE ${e.dateRangePredicate} AND ${e.platformPredicate}
  ), coverage AS (
    SELECT kind, COUNT(DISTINCT day) AS available_days FROM facts GROUP BY kind
  ), losses AS (SELECT kind, state_group, ${scope.byMachine ? "machine," : ""}
    SUM(seconds)/3600.0 AS loss_hours, COUNT(*) AS records, COUNT(DISTINCT day) AS observed_days
    FROM facts WHERE ${predicates.join(" AND ")}
    GROUP BY kind, state_group${scope.byMachine ? ", machine" : ""}
  ) SELECT losses.*, coverage.available_days AS kind_availability_days,
    ${selectedDays} AS selected_days,
    loss_hours / NULLIF(coverage.available_days, 0) AS hours_per_kind_available_day,
    loss_hours / ${selectedDays} AS hours_per_selected_day
  FROM losses JOIN coverage USING (kind)
  ORDER BY kind, loss_hours DESC, state_group${scope.byMachine ? ", machine" : ""}`;
  // Look at persisted names so repeated queries and restored sessions never replace a measurement.
  const names = new Set(artifacts.listDataSnapshots().map((entry) => entry.name));
  const baseName = "loss-" + range.start.replaceAll("-", "") + "-" + range.end.replaceAll("-", "");
  let name = baseName;
  for (let suffix = 2; names.has(artifacts.snapshotName(name)); suffix += 1) name = baseName + "-" + suffix;
  const { value: _value, replaced: _replaced, ...snapshot } = artifacts.createDataSnapshot(name, (fileDescriptor) => {
    const exported = database.exportQueryJson(sql, parameters, {
      fileDescriptor, maxRows: 100_000, maxBytes: MAX_QUERY_ARTIFACT_BYTES, previewRows: 0,
      ...(signal === undefined ? {} : { signal }),
    });
    if (exported.truncated) {
      throw new Error("损失查询结果超过" + (exported.truncationReason === "row_limit" ? "行数" : "字节") + "上限，快照未保存，请缩小查询范围");
    }
    return exported;
  });
  const data = JSON.parse(readFileSync(artifacts.resolveDataSnapshot(snapshot.name).filePath, "utf8")) as { rows: DashboardRow[] };
  return { sql, parameters, range, scope, rows: data.rows, snapshot, truncated: false };
}

export function createMeasureLossTool(
  database: Pick<AppDatabase, "exportQueryJson">,
  artifacts: SessionArtifactStore,
  recordEvidence?: (measurement: LossMeasurement) => string,
) {
  return defineTool({
    name: MEASURE_LOSS_TOOL_NAME,
    label: "查询标准实测损失",
    description: "Query non-Machine_Running Availability losses for an inclusive business-day range using canonical date/PCIe/MT/ST rules, with no LOT prefix filter (LOT eligibility applies only to Yield). Read the Test OEE Skill and references first. Optional states/machines narrow losses, never type-wide coverage days; by_machine adds machine detail. Rows include loss_hours, observed_days (loss occurrence days), kind_availability_days (all covered days of that type), selected_days and daily averages. Empty rows do not prove zero loss or complete coverage. Always save a complete snapshot under a unique date-based name, up to 100,000 rows or 32 MiB; exceeding either limit fails without saving. Returns complete rows for small results or bounded summaries/rankings. snapshot.name can be passed to code_interpreter or update_dashboard. row_index refers to the original snapshot row. Daily analysis also returns an evidence_id for audited report references; derived totals cannot supply loss_reference.",
    promptSnippet: "按业务日范围查询标准损失，保存完整快照并返回明细或摘要",
    executionMode: "sequential",
    parameters: measureLossParameters,
    async execute(_id, params, signal) {
      const measurement = measureLoss(database, artifacts, params, signal);
      return lossOutput(measurement, recordEvidence?.(measurement));
    },
  });
}
