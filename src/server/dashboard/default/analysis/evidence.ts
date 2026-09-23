import { readFileSync, writeSync } from "node:fs";
import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import { AppDatabase, assertReadOnlyQuery, type SqlParameter } from "../../../database/database.ts";
import { MAX_QUERY_ARTIFACT_BYTES, normalizeDataSnapshotName, type DataSnapshotDescriptor, type SessionArtifactStore } from "../../../tool/artifact-store.ts";
import { getDefaultTestOeeSql } from "../../../skills/test-oee-calculator/assets/test-oee-calculator.ts";
import { dashboardPeriods, weekLabel, PERIOD_KEYS, type PeriodKey } from "../periods.ts";
import { addDays, type DatePeriod } from "../../../database/business-dates.ts";
import type { LossMeasurement, LossScope } from "../../../tool/loss-tools.ts";
import type { DashboardRow, DashboardState } from "../../../../shared/dashboard.ts";

export interface Evidence {
  readonly id: string;
  readonly sql: string;
  readonly parameters: readonly SQLInputValue[];
  readonly rows: readonly DashboardRow[];
  readonly truncated: boolean;
  readonly sourceId?: string;
  readonly range?: DatePeriod;
  readonly source?: "measure_loss";
  readonly lossScope?: LossScope;
  readonly snapshot?: DataSnapshotDescriptor;
  readonly owner?: EvidenceOwner;
}

export interface EvidenceOwner {
  readonly period: PeriodKey;
  readonly agentId: string;
}

export interface AnalysisEvidenceScope extends EvidenceOwner {
  readonly baselineIds: readonly string[];
}

export interface AnalysisContext {
  readonly throughDate: string;
  readonly periods: ReturnType<typeof dashboardPeriods>;
  readonly comparisons: Record<PeriodKey, {
    readonly current: Evidence;
    readonly minimum: Evidence;
    readonly history: Evidence;
  }>;
  readonly dashboard: DashboardState;
}

function normalize(row: Record<string, unknown>): DashboardRow {
  return Object.fromEntries(Object.entries(row).map(([key, value]) => {
    if (value === null || typeof value === "string" || (typeof value === "number" && Number.isFinite(value))) {
      return [key, value];
    }
    throw new Error("查询证据包含不可表示的值：" + key);
  }));
}

/** Every reference resolves to a result from this run's single read transaction. */
export class AnalysisEvidence {
  readonly records = new Map<string, Evidence>();
  readonly queries: Pick<AppDatabase, "query" | "exportQueryJson">;
  readonly artifacts: SessionArtifactStore | undefined;
  readonly #database: DatabaseSync;
  readonly #onEvidence: (evidence: Evidence) => void;
  #pendingWrite: Promise<unknown> = Promise.resolve();

  /** Reserve names, write the snapshot and register evidence as one operation across all agents. */
  async withEvidenceWrite<T>(operation: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    const result = this.#pendingWrite.then(() => {
      signal?.throwIfAborted();
      return operation();
    });
    this.#pendingWrite = result.catch(() => {});
    return result;
  }

  constructor(database: DatabaseSync, onEvidence: (evidence: Evidence) => void = () => {}, artifacts?: SessionArtifactStore) {
    this.#database = database;
    this.#onEvidence = onEvidence;
    this.queries = AppDatabase.readOnlyQueries(database);
    this.artifacts = artifacts;
  }

  #save(record: Omit<Evidence, "id">): Evidence {
    const id = "q" + (this.records.size + 1);
    let snapshot = record.snapshot;
    if (this.artifacts && !snapshot && !record.truncated) {
      const columns = [...new Set(record.rows.flatMap((row) => Object.keys(row)))];
      const content = JSON.stringify({ columns, rows: record.rows, rowCount: record.rows.length, truncated: false });
      if (Buffer.byteLength(content) > MAX_QUERY_ARTIFACT_BYTES) throw new Error("分析证据超过快照大小上限，请缩小查询范围");
      const { value: _value, replaced: _replaced, ...descriptor } = this.artifacts.createDataSnapshot("evidence-" + id, (fd) => {
        writeSync(fd, content);
        return { columns, rowCount: record.rows.length };
      });
      snapshot = descriptor;
    }
    const evidence: Evidence = { id, ...record, ...(snapshot ? { snapshot } : {}) };
    this.records.set(evidence.id, evidence);
    this.#onEvidence(evidence);
    return evidence;
  }

  /** Register the complete result exported by the shared SQL tool, never its preview. */
  recordSnapshot(sql: string, parameters: readonly SqlParameter[], name: string, owner: EvidenceOwner): Evidence {
    if (!this.artifacts) throw new Error("分析快照存储尚未初始化");
    const { filePath, ...snapshot } = this.artifacts.resolveDataSnapshot(name);
    const data = JSON.parse(readFileSync(filePath, "utf8")) as { rows: DashboardRow[]; truncated: boolean };
    if (data.truncated) throw new Error("分析证据快照被截断");
    return this.#save({ sql, parameters: parameters.map((value) => typeof value === "boolean" ? Number(value) : value),
      rows: data.rows, truncated: false, snapshot, owner });
  }

  scope(context: AnalysisContext, period: PeriodKey, agentId: string): AnalysisEvidenceScope {
    return { period, agentId, baselineIds: Object.values(context.comparisons[period]).map((record) => record.id) };
  }

  #visible(record: Evidence, scope: AnalysisEvidenceScope): boolean {
    return record.owner?.period === scope.period &&
      (scope.baselineIds.includes(record.id) || record.owner.agentId === scope.agentId);
  }

  /** Check before resolving a name: the shared store's missing-name error lists all snapshots. */
  assertSnapshotAccess(name: string, scope: AnalysisEvidenceScope): void {
    const normalized = normalizeDataSnapshotName(name);
    if (![...this.records.values()].some((record) => record.snapshot?.name === normalized && this.#visible(record, scope))) {
      throw new Error("当前子任务无可用的该证据快照，请使用本周期证据目录中的名称");
    }
  }

  catalog(scope?: AnalysisEvidenceScope) {
    return [...this.records.values()].filter((record) => !scope || this.#visible(record, scope)).map((record) => ({
      evidence_id: record.id, snapshot: record.snapshot?.name ?? null, row_count: record.rows.length,
      truncated: record.truncated, range: record.range, source: record.source, loss_scope: record.lossScope, owner: record.owner,
    }));
  }

  query(sql: string, parameters: readonly SQLInputValue[] = [], maxRows = 200, owner?: EvidenceOwner): Evidence {
    return this.#save({ ...this.#read(sql, parameters, maxRows), ...(owner ? { owner } : {}) });
  }

  #read(sql: string, parameters: readonly SQLInputValue[], maxRows = 200): Omit<Evidence, "id"> {
    assertReadOnlyQuery(sql);
    const rows: DashboardRow[] = [];
    let bytes = 0;
    let truncated = false;
    for (const raw of this.#database.prepare(sql).iterate(...parameters)) {
      const row = normalize(raw);
      bytes += Buffer.byteLength(JSON.stringify(row));
      if (rows.length === maxRows || bytes > (maxRows > 200 ? MAX_QUERY_ARTIFACT_BYTES - 4096 : 512 * 1024)) { truncated = true; break; }
      rows.push(row);
    }
    return { sql, parameters, rows, truncated };
  }

  context(state: DashboardState, throughDate: string): AnalysisContext {
    const periods = dashboardPeriods(throughDate);
    const source = this.query(getDefaultTestOeeSql(periods.syncStart, throughDate).sql, [], 800);
    if (source.truncated) throw new Error("基础分析证据被截断");
    const slice = (period: PeriodKey, range: DatePeriod | undefined): Evidence => this.#save({
      sql: source.sql, parameters: [], sourceId: source.id, ...(range ? { range } : {}),
      owner: { period, agentId: "baseline" },
      rows: range ? source.rows.filter((row) => String(row["day"]) >= range.start && String(row["day"]) <= range.end) : [],
      truncated: false,
    });
    const comparisons = {} as AnalysisContext["comparisons"];
    for (const key of PERIOD_KEYS) {
      const grain = { week: "周", month: "月", quarter: "季" }[key];
      const minimum = state.widgets.find((widget) => widget.id === "oee-extremes-table-2026")?.data
        .find((row) => row["grain"] === grain && row["point_type"] === "最低");
      const label = minimum?.["period_label"];
      const days: string[] = [];
      for (let day = periods.trend.start; day <= throughDate; day = addDays(day, 1)) {
        const dayLabel = key === "week" ? weekLabel(day) : key === "month" ? day.slice(0, 7) :
          day.slice(0, 4) + "-Q" + Math.ceil(Number(day.slice(5, 7)) / 3);
        if (dayLabel === label) days.push(day);
      }
      comparisons[key] = {
        current: slice(key, periods[key]),
        minimum: slice(key, days.length ? { start: days[0]!, end: days.at(-1)! } : undefined),
        history: slice(key, periods[key].start > periods.trend.start ? {
          start: periods.trend.start, end: addDays(periods[key].start, -1),
        } : undefined),
      };
    }
    return { throughDate, periods, comparisons, dashboard: state };
  }

  /** Only the shared standard measurement path can mark report loss references. */
  recordLoss(measurement: LossMeasurement, owner: EvidenceOwner): Evidence {
    return this.#save({
      sql: measurement.sql,
      parameters: measurement.parameters.map((value) => typeof value === "boolean" ? Number(value) : value),
      rows: measurement.rows, truncated: false, snapshot: measurement.snapshot,
      range: measurement.range, lossScope: measurement.scope, source: "measure_loss", owner,
    });
  }
}
