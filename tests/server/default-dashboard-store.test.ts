import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { readDefaultDashboard, writeDefaultDashboard } from "../../src/server/dashboard/default/store.ts";
import { createDefaultDashboard } from "../../src/server/dashboard/default/template.ts";
import { SessionDashboardStore } from "../../src/server/dashboard/session-store.ts";
import { ArtifactStore } from "../../src/server/tool/artifact-store.ts";

test("new defaults affect only new sessions, including when an empty session is already open", (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "dashboard-default-store-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, "default.json");
  const artifacts = new ArtifactStore(path.join(root, "artifacts"));
  const dashboard = new SessionDashboardStore(artifacts, () => readDefaultDashboard(file));
  const first = createDefaultDashboard();
  writeDefaultDashboard(file, first);
  const preview = dashboard.loadOrPreview("empty-session-a");
  assert.equal(existsSync(path.join(artifacts.rootDir, "empty-session-a")), false);
  const second = { ...first, dataAsOf: "2026-09-16T01:00:00.000Z" };
  writeDefaultDashboard(file, second);
  assert.deepEqual(dashboard.loadOrPreview("empty-session-a"), preview);
  assert.deepEqual(dashboard.loadOrPreview("empty-session-b"), second);
  const edited = dashboard.apply("empty-session-a", { action: "remove", baseRevision: 0, widgetId: first.widgets[0]!.id });
  const restarted = new SessionDashboardStore(artifacts, () => readDefaultDashboard(file));
  assert.deepEqual(restarted.loadOrPreview("empty-session-a"), edited.dashboard);
  assert.deepEqual(restarted.apply("empty-session-a", { action: "reset", baseRevision: 1 }).dashboard, { ...first, revision: 2 });
  assert.deepEqual(restarted.loadOrInitialize("empty-session-c"), second);
});

test("invalid or missing default files fall back with a diagnostic", (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "dashboard-default-fallback-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, "default.json");
  const events: string[] = [];
  const logger = { info(event: string) { events.push(event); }, error(event: string) { events.push(event); } };
  assert.deepEqual(readDefaultDashboard(file, logger), createDefaultDashboard());
  writeFileSync(file, "{broken");
  assert.deepEqual(readDefaultDashboard(file, logger), createDefaultDashboard());
  writeFileSync(file, JSON.stringify({ ...createDefaultDashboard(), widgets: [] }));
  assert.deepEqual(readDefaultDashboard(file, logger), createDefaultDashboard());
  assert.deepEqual(events, ["dashboard.default.fallback", "dashboard.default.invalid", "dashboard.default.invalid"]);
});

test("old defaults split their known type OEE without inventing components or changing existing sessions", (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "dashboard-split-overviews-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, "default.json");
  const current = createDefaultDashboard();
  const mt = current.widgets[0]!;
  assert.ok(mt.kind === "overview");
  const legacy = {
    ...current, dataAsOf: "2026-09-16T01:00:00.000Z",
    widgets: [{
      ...mt, id: "overall-oee-overview", title: "Overall OEE",
      data: [{ overall_oee_percent: 41, mt_oee_percent: 21, st_oee_percent: 62,
        avg_availability_percent: 87, avg_performance_percent: 88, avg_yield_percent: 89 }],
    }, ...current.widgets.slice(2)],
  };
  const artifacts = new ArtifactStore(path.join(root, "artifacts"));
  const sessions = new SessionDashboardStore(artifacts, () => legacy);
  const pinned = sessions.loadOrInitialize("existing");
  writeFileSync(file, JSON.stringify(legacy));
  const before = readFileSync(file, "utf8");
  const migrated = readDefaultDashboard(file);
  assert.equal(migrated.widgets.length, 10);
  assert.equal(migrated.dataAsOf, legacy.dataAsOf);
  assert.deepEqual(migrated.dateRange, legacy.dateRange);
  assert.deepEqual(migrated.widgets.slice(2), legacy.widgets.slice(1));
  assert.deepEqual(migrated.widgets.slice(0, 2).map((widget) => widget.data[0]), [
    { overall_oee_percent: 21, avg_availability_percent: null, avg_performance_percent: null, avg_yield_percent: null },
    { overall_oee_percent: 62, avg_availability_percent: null, avg_performance_percent: null, avg_yield_percent: null },
  ]);
  assert.ok(migrated.widgets.slice(0, 2).every((widget) => widget.warnings.some((warning) => warning.includes("旧版快照"))));
  assert.equal(readFileSync(file, "utf8"), before, "reading a default never rewrites its snapshot");
  const reopened = new SessionDashboardStore(artifacts, () => readDefaultDashboard(file));
  assert.deepEqual(reopened.loadOrInitialize("existing"), pinned);
  assert.deepEqual(reopened.loadOrPreview("new-session"), migrated);
  // A former quarter/month/week default must still retain its published data.
  const [overview, weekly, monthly, quarterly, ...rest] = legacy.widgets;
  writeFileSync(file, JSON.stringify({ ...legacy, widgets: [overview, quarterly, monthly, weekly, ...rest] }));
  assert.deepEqual(readDefaultDashboard(file), migrated);
});

test("publication validates before writing and cleans temporary files after rename failure", (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "dashboard-default-atomic-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, "default.json");
  const state = createDefaultDashboard();
  writeDefaultDashboard(file, state);
  const original = readFileSync(file, "utf8");
  assert.throws(() => writeDefaultDashboard(file, { ...state, widgets: [] }));
  assert.equal(readFileSync(file, "utf8"), original);
  const directoryTarget = path.join(root, "blocked");
  mkdirSync(directoryTarget);
  assert.throws(() => writeDefaultDashboard(directoryTarget, state));
  assert.equal(readFileSync(file, "utf8"), original);
  assert.deepEqual(readdirSync(root).sort(), ["blocked", "default.json"]);
});
