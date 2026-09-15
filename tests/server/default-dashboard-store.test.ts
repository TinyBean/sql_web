import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { readDefaultDashboard, writeDefaultDashboard } from "../../src/server/tool/default-dashboard-store.ts";
import { createDefaultDashboard } from "../../src/server/tool/default-dashboard.ts";
import { DashboardModule } from "../../src/server/tool/dashboard.ts";
import { ArtifactStore } from "../../src/server/tool/artifact-store.ts";

test("new defaults affect only new sessions, including when an empty session is already open", (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "dashboard-default-store-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, "default.json");
  const artifacts = new ArtifactStore(path.join(root, "artifacts"));
  const dashboard = new DashboardModule(artifacts, file);
  const first = createDefaultDashboard();
  writeDefaultDashboard(file, first);
  const preview = dashboard.loadOrPreview("empty-session-a");
  assert.equal(existsSync(path.join(artifacts.rootDir, "empty-session-a")), false);
  const second = { ...first, dataAsOf: "2026-09-16T01:00:00.000Z" };
  writeDefaultDashboard(file, second);
  assert.deepEqual(dashboard.loadOrPreview("empty-session-a"), preview);
  assert.deepEqual(dashboard.loadOrPreview("empty-session-b"), second);
  const edited = dashboard.apply("empty-session-a", { action: "remove", baseRevision: 0, widgetId: first.widgets[0]!.id });
  const restarted = new DashboardModule(artifacts, file);
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
