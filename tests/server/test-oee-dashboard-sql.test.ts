import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test, { type TestContext } from "node:test";
import type { DashboardRow } from "../../src/shared/dashboard.ts";
import { buildTypeOverviews } from "../../src/server/dashboard/default/overviews.ts";
import { createDefaultDashboard } from "../../src/server/dashboard/default/template.ts";
import { SessionDashboardStore } from "../../src/server/dashboard/session-store.ts";
import {
  getDefaultTestOeeDashboardSql,
  getDefaultTestOeeSql,
} from "../../src/server/skills/test-oee-calculator/assets/test-oee-calculator.ts";
import { ArtifactStore } from "../../src/server/tool/artifact-store.ts";

const range = { start: "2026-01-01", end: "2026-01-04" };

function databaseFixture(t: TestContext): DatabaseSync {
  const database = new DatabaseSync(":memory:");
  t.after(() => database.close());
  database.exec(`CREATE TABLE oee_availability (
    tool_name TEXT, lot_id TEXT, final_state TEXT, step TEXT, date TEXT, time_span INTEGER
  );
  CREATE TABLE oee_dut_utilization (
    machine_id TEXT, lot_id TEXT, in_qty TEXT, out_qty TEXT, dut_num TEXT, step_id TEXT, date TEXT
  );`);
  return database;
}

function addDay(
  database: DatabaseSync,
  kind: "MT" | "ST",
  day: string,
  availability: number | null,
  quantities: readonly [input: number, output: number, sockets: number] | null,
): void {
  const machine = kind === "MT" ? "ADH001" : "ADH002";
  const step = kind === "MT" ? "5000" : "7000";
  const date = `${day}T00:00:00.000Z`;
  if (availability !== null) {
    const insert = database.prepare("INSERT INTO oee_availability VALUES (?, 'P1', ?, ?, ?, ?)");
    if (availability > 0) insert.run(machine, "Test(Normal)", step, date, availability * 86_400);
    if (availability < 1) insert.run(machine, "IDLE", step, date, (1 - availability) * 86_400);
  }
  if (quantities !== null) {
    database.prepare("INSERT INTO oee_dut_utilization VALUES (?, 'P1', ?, ?, ?, ?, ?)").run(
      machine, ...quantities.map(String), step, date,
    );
  }
}

function query(database: DatabaseSync, sql: string): DashboardRow[] {
  return database.prepare(sql).all().map((row) => Object.fromEntries(Object.entries(row).map(([key, value]) => {
    assert.ok(value === null || typeof value === "number" || typeof value === "string");
    return [key, value];
  })));
}

function overview(database: DatabaseSync, period = range): DashboardRow {
  const rows = query(database, getDefaultTestOeeDashboardSql(period.start, period.end, "overview").sql);
  assert.equal(rows.length, 1);
  return rows[0]!;
}

function assertValues(actual: DashboardRow, expected: DashboardRow): void {
  for (const [column, value] of Object.entries(expected)) {
    if (typeof value === "number") {
      const result = actual[column];
      assert.equal(typeof result, "number", column);
      assert.ok(Math.abs(Number(result) - value) < 1e-10, `${column}: expected ${value}, got ${result}`);
    } else {
      assert.equal(actual[column], value, column);
    }
  }
}

test("overview keeps type-specific components on the OEE sample and preserves combined metrics", (t) => {
  const database = databaseFixture(t);
  addDay(database, "MT", range.start, .25, [80, 80, 100]); // OEE 20%
  addDay(database, "MT", "2026-01-02", .75, [40, 20, 100]); // OEE 15%
  addDay(database, "MT", "2026-01-03", 1, null); // Availability without DUT
  addDay(database, "MT", range.end, null, [90, 81, 100]); // DUT without Availability
  addDay(database, "ST", range.start, 1, [50, 40, 100]); // OEE 40%
  // ST has no records on January 2; its other two days have zero denominators.
  addDay(database, "ST", "2026-01-03", .1, [20, 20, 0]);
  addDay(database, "ST", range.end, .2, [0, 0, 100]);

  const row = overview(database);
  assertValues(row, {
    mt_oee_percent: 17.5, mt_availability_percent: 50, mt_performance_percent: 60, mt_yield_percent: 75,
    st_oee_percent: 40, st_availability_percent: 100, st_performance_percent: 50, st_yield_percent: 80,
    overall_oee_percent: 25, avg_availability_percent: 200 / 3,
    avg_performance_percent: 170 / 3, avg_yield_percent: 230 / 3,
    mt_calculable_day_count: 2, mt_selected_day_count: 4, mt_availability_day_count: 3, mt_dut_day_count: 2,
    st_calculable_day_count: 1, st_selected_day_count: 4, st_availability_day_count: 3, st_dut_day_count: 3,
    calculable_day_type_count: 3, selected_day_type_count: 8, availability_day_type_count: 6, dut_day_type_count: 5,
  });

  const daily = query(database, getDefaultTestOeeSql(range.start, range.end).sql);
  for (const card of buildTypeOverviews(daily, range)) {
    const prefix = card.id.startsWith("mt-") ? "mt" : "st";
    assertValues(card.data[0]!, {
      overall_oee_percent: row[`${prefix}_oee_percent`]!,
      avg_availability_percent: row[`${prefix}_availability_percent`]!,
      avg_performance_percent: row[`${prefix}_performance_percent`]!,
      avg_yield_percent: row[`${prefix}_yield_percent`]!,
    });
  }
});

test("overview retains zero OEE and never borrows metrics for an absent type or empty period", (t) => {
  const database = databaseFixture(t);
  const period = { start: range.start, end: "2026-01-02" };
  addDay(database, "MT", period.start, 0, [40, 20, 100]); // All loss, but calculable
  addDay(database, "MT", period.end, .75, null);
  assertValues(overview(database, period), {
    mt_oee_percent: 0, mt_availability_percent: 0, mt_performance_percent: 40, mt_yield_percent: 50,
    st_oee_percent: null, st_availability_percent: null, st_performance_percent: null, st_yield_percent: null,
    overall_oee_percent: 0, avg_availability_percent: 0, avg_performance_percent: 40, avg_yield_percent: 50,
    mt_calculable_day_count: 1, mt_selected_day_count: 2, mt_availability_day_count: 2, mt_dut_day_count: 1,
    st_calculable_day_count: 0, st_selected_day_count: 2, st_availability_day_count: 0, st_dut_day_count: 0,
    calculable_day_type_count: 1, selected_day_type_count: 4, availability_day_type_count: 2, dut_day_type_count: 1,
  });

  const empty = overview(database, { start: "2026-02-01", end: "2026-02-02" });
  for (const prefix of ["mt", "st"]) {
    assertValues(empty, {
      [`${prefix}_oee_percent`]: null, [`${prefix}_availability_percent`]: null,
      [`${prefix}_performance_percent`]: null, [`${prefix}_yield_percent`]: null,
      [`${prefix}_calculable_day_count`]: 0, [`${prefix}_selected_day_count`]: 2,
      [`${prefix}_availability_day_count`]: 0, [`${prefix}_dut_day_count`]: 0,
    });
  }
  assertValues(empty, {
    overall_oee_percent: null, avg_availability_percent: null, avg_performance_percent: null, avg_yield_percent: null,
    calculable_day_type_count: 0, selected_day_type_count: 4, availability_day_type_count: 0, dut_day_type_count: 0,
  });
});

test("one overview SQL snapshot saves two independent type cards without changing existing cards", (t) => {
  const database = databaseFixture(t);
  addDay(database, "MT", range.start, .5, [80, 60, 100]);
  addDay(database, "ST", range.start, 1, [50, 40, 100]);
  const rows = [overview(database)];
  const columns = Object.keys(rows[0]!);
  const directory = mkdtempSync(path.join(tmpdir(), "test-oee-overview-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const sessionId = "test-oee-overview-session";
  const artifacts = new ArtifactStore(directory);
  const store = new SessionDashboardStore(artifacts, createDefaultDashboard);
  const baseline = store.loadOrInitialize(sessionId);
  const snapshot = artifacts.forSession(sessionId).createDataSnapshot("type-overviews", (fileDescriptor) => {
    writeSync(fileDescriptor, JSON.stringify({ columns, rows, rowCount: 1, truncated: false }));
    return { columns, rowCount: 1 };
  });

  let revision = baseline.revision;
  for (const prefix of ["mt", "st"] as const) {
    const result = store.apply(sessionId, {
      action: "upsert", baseRevision: revision, dateRange: range, snapshot: snapshot.name,
      widget: {
        id: `${prefix}-oee-overview-period`, kind: "overview", size: "wide",
        title: `${prefix.toUpperCase()} · OEE 概览`, subtitle: `${range.start} 至 ${range.end}`,
        format: { unit: "%", precision: 2 },
        metricDefinition: `${prefix.toUpperCase()} 四项指标均为该类型 OEE 可计算日等权平均`, warnings: [],
        encoding: {
          value: `${prefix}_oee_percent`, label: "Overall OEE",
          description: `覆盖 ${rows[0]![`${prefix}_calculable_day_count`]}/${rows[0]![`${prefix}_selected_day_count`]} 个可计算业务日`,
          gauges: [
            { name: "Availability", column: `${prefix}_availability_percent` },
            { name: "Performance", column: `${prefix}_performance_percent` },
            { name: "Yield", column: `${prefix}_yield_percent` },
          ],
        },
      },
    });
    revision = result.dashboard.revision;
  }

  // Reload from disk so this checks the persisted mapping and values, not only the apply result.
  const saved = new SessionDashboardStore(artifacts, createDefaultDashboard).loadOrPreview(sessionId);
  assert.equal(saved.revision, baseline.revision + 2);
  assert.deepEqual(saved.widgets.slice(0, baseline.widgets.length), baseline.widgets);
  for (const [prefix, expected] of [
    ["mt", [30, 50, 80, 75]],
    ["st", [40, 100, 50, 80]],
  ] as const) {
    const card = saved.widgets.find((widget) => widget.id === `${prefix}-oee-overview-period`);
    assert.ok(card?.kind === "overview");
    assert.equal(card.encoding.description, "覆盖 1/4 个可计算业务日");
    assertValues(card.data[0]!, {
      [card.encoding.value]: expected[0],
      [card.encoding.gauges[0]!.column]: expected[1],
      [card.encoding.gauges[1]!.column]: expected[2],
      [card.encoding.gauges[2]!.column]: expected[3],
    });
    assert.deepEqual(Object.keys(card.data[0]!), [
      `${prefix}_oee_percent`, `${prefix}_availability_percent`, `${prefix}_performance_percent`, `${prefix}_yield_percent`,
    ]);
  }
  store.dispose();
});
