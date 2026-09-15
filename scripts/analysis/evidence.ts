import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import { assertReadOnlyQuery } from "../../src/server/database/database.ts";
import { getDefaultTestOeeSql, getTestOeeSqlExpressions } from "../../src/server/skills/test-oee-calculator/assets/test-oee-calculator.ts";
import { addDays, dashboardPeriods, weekLabel, type DatePeriod } from "../../src/server/tool/dashboard-periods.ts";
import type { DashboardRow, DashboardState } from "../../src/shared/dashboard.ts";

export const PERIOD_KEYS = ["week", "month", "quarter"] as const;
export type PeriodKey = typeof PERIOD_KEYS[number];
export interface Evidence {
  readonly id: string;
  readonly sql: string;
  readonly parameters: readonly SQLInputValue[];
  readonly rows: readonly DashboardRow[];
  readonly truncated: boolean;
  readonly sourceId?: string;
  readonly range?: DatePeriod;
  readonly lossPeriod?: PeriodKey;
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
  readonly #database: DatabaseSync;
  readonly #onEvidence: (evidence: Evidence) => void;

  constructor(database: DatabaseSync, onEvidence: (evidence: Evidence) => void = () => {}) {
    this.#database = database;
    this.#onEvidence = onEvidence;
  }

  #save(record: Omit<Evidence, "id">): Evidence {
    const evidence = { id: "q" + (this.records.size + 1), ...record };
    this.records.set(evidence.id, evidence);
    this.#onEvidence(evidence);
    return evidence;
  }

  query(sql: string, parameters: readonly SQLInputValue[] = [], maxRows = 200): Evidence {
    return this.#save(this.#read(sql, parameters, maxRows));
  }

  #read(sql: string, parameters: readonly SQLInputValue[], maxRows = 200): Omit<Evidence, "id"> {
    assertReadOnlyQuery(sql);
    const rows: DashboardRow[] = [];
    let bytes = 0;
    let truncated = false;
    for (const raw of this.#database.prepare(sql).iterate(...parameters)) {
      const row = normalize(raw);
      bytes += Buffer.byteLength(JSON.stringify(row));
      if (rows.length === maxRows || bytes > (maxRows > 200 ? 4 * 1024 * 1024 : 512 * 1024)) { truncated = true; break; }
      rows.push(row);
    }
    return { sql, parameters, rows, truncated };
  }

  context(state: DashboardState, throughDate: string): AnalysisContext {
    const periods = dashboardPeriods(throughDate);
    const source = this.query(getDefaultTestOeeSql(periods.syncStart, throughDate).sql, [], 800);
    if (source.truncated) throw new Error("基础分析证据被截断");
    const slice = (range: DatePeriod | undefined): Evidence => this.#save({
      sql: source.sql, parameters: [], sourceId: source.id, ...(range ? { range } : {}),
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
        current: slice(periods[key]),
        minimum: slice(days.length ? { start: days[0]!, end: days.at(-1)! } : undefined),
        history: slice(periods[key].start > periods.trend.start ? {
          start: periods.trend.start, end: addDays(periods[key].start, -1),
        } : undefined),
      };
    }
    return { throughDate, periods, comparisons, dashboard: state };
  }

  measureLoss(
    periodKey: PeriodKey, period: DatePeriod,
    states: readonly string[] = [], machines: readonly string[] = [], byMachine = false,
  ): Evidence {
    const e = getTestOeeSqlExpressions("availability", period.start, period.end, "a");
    const predicates: string[] = ["kind IN ('MT','ST')", "state_group <> 'Machine_Running'"];
    const parameters: SQLInputValue[] = [];
    if (states.length) {
      predicates.push("state_group IN (" + states.map(() => "?").join(",") + ")");
      parameters.push(...states);
    }
    if (machines.length) {
      predicates.push("machine IN (" + machines.map(() => "?").join(",") + ")");
      parameters.push(...machines);
    }
    const sql = `WITH facts AS (
      SELECT ${e.dayExpression} AS day, ${e.kindExpression} AS kind,
        ${e.availabilityStateExpression} AS state_group, a.tool_name AS machine,
        CAST(a.time_span AS REAL) AS seconds
      FROM oee_availability a
      WHERE ${e.dateRangePredicate} AND ${e.lotPredicate} AND ${e.platformPredicate}
    ), coverage AS (
      SELECT kind, COUNT(DISTINCT day) AS available_days FROM facts GROUP BY kind
    ), losses AS (SELECT kind, state_group, ${byMachine ? "machine," : ""}
      SUM(seconds)/3600.0 AS loss_hours, COUNT(*) AS records, COUNT(DISTINCT day) AS observed_days
    FROM facts WHERE ${predicates.join(" AND ")}
    GROUP BY kind, state_group${byMachine ? ", machine" : ""}
    ) SELECT losses.*, coverage.available_days AS kind_availability_days,
      ${(Date.parse(period.end) - Date.parse(period.start)) / 86_400_000 + 1} AS selected_days,
      loss_hours / NULLIF(coverage.available_days, 0) AS hours_per_kind_available_day,
      loss_hours / ${(Date.parse(period.end) - Date.parse(period.start)) / 86_400_000 + 1} AS hours_per_selected_day
    FROM losses JOIN coverage USING (kind)
    ORDER BY kind, loss_hours DESC, state_group${byMachine ? ", machine" : ""}`;
    // Only this program-generated measurement can supply display hours.
    return this.#save({ ...this.#read(sql, parameters), lossPeriod: periodKey, range: period });
  }
}
