import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { readDefaultDashboard, writeDefaultDashboard } from "../../src/server/dashboard/default/store.ts";
import { createDefaultDashboard } from "../../src/server/dashboard/default/template.ts";
import { SessionDashboardStore } from "../../src/server/agent/session-dashboard.ts";
import { ArtifactStore } from "../../src/server/tool/artifact-store.ts";

test("new defaults affect only new sessions, including when an empty session is already open", (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "dashboard-default-store-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, "default.json");
  const artifacts = new ArtifactStore(path.join(root, "artifacts"));
  const dashboard = new SessionDashboardStore(artifacts, () => readDefaultDashboard(file));
  const template = createDefaultDashboard();
  const first = { ...template, dateRange: { start: "2026-01-01", end: "2026-09-14" },
    widgets: template.widgets.map((widget) => widget.id === "mt-oee-overview"
      ? { ...widget, data: [{ ...widget.data[0], overall_oee_percent: 42 }] } : widget) };
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
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-09-22T01:00:00Z") });
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

test("an empty fallback stays pinned after publication and remains the saved session's reset baseline", (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "dashboard-empty-baseline-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, "default.json");
  const artifacts = new ArtifactStore(path.join(root, "artifacts"));
  const sessions = new SessionDashboardStore(artifacts, () => readDefaultDashboard(file));
  const empty = sessions.loadOrPreview("empty-session");
  assert.deepEqual(empty.dateRange, { start: null, end: null });
  assert.equal(existsSync(path.join(artifacts.rootDir, "empty-session")), false);
  const published = { ...empty, dateRange: { start: "2026-01-01", end: "2026-01-12" },
    widgets: empty.widgets.map((widget) => widget.id === "mt-oee-overview"
      ? { ...widget, data: [{ ...widget.data[0], overall_oee_percent: 35 }] } : widget) };
  writeDefaultDashboard(file, published);
  assert.deepEqual(sessions.loadOrPreview("empty-session"), empty);
  assert.deepEqual(sessions.loadOrPreview("new-session"), published);
  sessions.apply("empty-session", { action: "remove", baseRevision: 0, widgetId: empty.widgets[0]!.id });
  const restarted = new SessionDashboardStore(artifacts, () => readDefaultDashboard(file));
  assert.deepEqual(restarted.apply("empty-session", { action: "reset", baseRevision: 1 }).dashboard,
    { ...empty, revision: 2 });
});

test("old default formats fall back without rewriting snapshots or changing historical sessions", (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-09-22T01:00:00Z") });
  const root = mkdtempSync(path.join(tmpdir(), "dashboard-default-legacy-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, "default.json");
  const current = createDefaultDashboard();
  const ten = current.widgets.filter((widget) => !widget.id.includes("effective"));
  const nine = [{ ...ten[0]!, id: "overall-oee-overview" }, ...ten.slice(2)];
  const threeFactor = ten.map((widget) => widget.kind === "overview" ? {
    ...widget,
    data: [{ overall_oee_percent: 45, avg_availability_percent: 60, avg_performance_percent: 75, avg_yield_percent: 100 }],
    encoding: { ...widget.encoding, gauges: [
      { name: "Availability", column: "avg_availability_percent" },
      { name: "Performance", column: "avg_performance_percent" },
      { name: "Yield", column: "avg_yield_percent" },
    ] },
  } : widget);
  const oldOrder = [...current.widgets];
  [oldOrder[4], oldOrder[6]] = [oldOrder[6]!, oldOrder[4]!];
  const artifacts = new ArtifactStore(path.join(root, "artifacts"));
  const events: string[] = [];
  const logger = { info() {}, error(event: string) { events.push(event); } };
  for (const [index, widgets] of [nine, ten, threeFactor, oldOrder].entries()) {
    const legacy = { ...current, widgets, dataAsOf: "2026-09-16T01:00:00.000Z" };
    const sessionId = "legacy-session-" + index;
    const sessions = new SessionDashboardStore(artifacts, () => legacy);
    const pinned = sessions.loadOrInitialize(sessionId);
    const original = JSON.stringify(legacy);
    writeFileSync(file, original);
    assert.deepEqual(readDefaultDashboard(file, logger), current);
    assert.equal(readFileSync(file, "utf8"), original);
    const reopened = new SessionDashboardStore(artifacts, () => readDefaultDashboard(file));
    assert.deepEqual(reopened.loadOrPreview(sessionId), pinned);
    assert.deepEqual(reopened.loadOrPreview("new-session-" + index), current);
    reopened.apply(sessionId, { action: "remove", baseRevision: 0, widgetId: pinned.widgets[0]!.id });
    assert.deepEqual(reopened.apply(sessionId, { action: "reset", baseRevision: 1 }).dashboard,
      { ...pinned, revision: 2 });
  }
  assert.deepEqual(events, Array(4).fill("dashboard.default.invalid"));
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
