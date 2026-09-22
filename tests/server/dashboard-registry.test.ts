import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import test, { type TestContext } from "node:test";
import { MAX_DASHBOARD_FILE_BYTES, parseDashboardState, type DashboardState } from "../../src/shared/dashboard.ts";
import { DashboardRegistry } from "../../src/server/dashboard/index.ts";
import { readDashboardSnapshot, writeDashboardSnapshot } from "../../src/server/dashboard/snapshot-store.ts";
import { SessionDashboardStore } from "../../src/server/agent/session-dashboard.ts";
import { ArtifactStore } from "../../src/server/tool/artifact-store.ts";

function snapshot(kind: "kpi" | "table"): DashboardState {
  const common = { title: "产量", subtitle: "本期", size: "small", format: { unit: "件", precision: 0 },
    metricDefinition: "已完成数量", warnings: [], data: [{ value: 10 }] };
  const kpi = { ...common, id: "production", kind: "kpi", encoding: { value: "value", comparison: null } };
  const table = { ...common, id: "production-table", kind: "table", encoding: { columns: [{ key: "value", label: "产量" }] } };
  return parseDashboardState({ schemaVersion: 1, revision: 0, dataAsOf: "2026-09-15T01:00:00.000Z",
    dateRange: { start: null, end: null }, widgets: kind === "kpi" ? [kpi] : [table, kpi] });
}

function fixture(t: TestContext) {
  const directory = mkdtempSync(path.join(tmpdir(), "dashboard-registry-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const first = snapshot("kpi");
  const second = snapshot("table");
  const firstFile = path.join(directory, "first.json");
  const secondFile = path.join(directory, "second.json");
  writeDashboardSnapshot(firstFile, first);
  writeDashboardSnapshot(secondFile, second);
  const registry = new DashboardRegistry([
    { id: "default", loadInitial: () => readDashboardSnapshot(firstFile) },
    { id: "production", loadInitial: () => readDashboardSnapshot(secondFile) },
  ]);
  return { directory, first, second, firstFile, secondFile, registry };
}

test("registry selects isolated snapshots with different card structures and rejects invalid registrations", (t) => {
  const { registry, first, second, firstFile } = fixture(t);
  assert.deepEqual(registry.list().map((item) => item.id), ["default", "production"]);
  assert.deepEqual(registry.loadInitial(), first);
  assert.deepEqual(registry.loadInitial("production"), second);
  const loaded = registry.loadInitial();
  Reflect.set(loaded.widgets[0]!.data[0]!, "value", -1);
  assert.deepEqual(registry.loadInitial(), first);
  writeDashboardSnapshot(firstFile, { ...first, widgets: [] });
  assert.deepEqual(registry.loadInitial().widgets, []);
  assert.deepEqual(registry.loadInitial("production"), second);
  assert.throws(() => registry.loadInitial("missing"), /未知看板/u);
  assert.throws(() => new DashboardRegistry([registry.list()[0]!, registry.list()[0]!]), /重复/u);
  assert.throws(() => new DashboardRegistry([{ id: "../outside", loadInitial: () => first }]), /无效/u);
  assert.throws(() => new DashboardRegistry([{ id: "default", loadInitial: () => ({ ...first, revision: 1 }) }]).loadInitial(), /revision/u);
});

test("generic snapshots validate before atomic publication and enforce file limits", (t) => {
  const { directory, firstFile, first } = fixture(t);
  const original = readFileSync(firstFile, "utf8");
  assert.equal(statSync(firstFile).mode & 0o777, 0o600);
  assert.throws(() => writeDashboardSnapshot(firstFile, { ...first, revision: 2 }), /revision/u);
  assert.throws(() => writeDashboardSnapshot(firstFile, first, () => { throw new Error("module validation"); }), /module validation/u);
  assert.equal(readFileSync(firstFile, "utf8"), original);
  const blocked = path.join(directory, "blocked");
  mkdirSync(blocked);
  assert.throws(() => writeDashboardSnapshot(blocked, first));
  assert.ok(readdirSync(directory).every((name) => !name.endsWith(".tmp")));
  const link = path.join(directory, "link.json");
  symlinkSync(firstFile, link);
  assert.throws(() => readDashboardSnapshot(link), /文件类型/u);
  writeFileSync(firstFile, "{broken");
  assert.throws(() => readDashboardSnapshot(firstFile));
  truncateSync(firstFile, MAX_DASHBOARD_FILE_BYTES + 1);
  assert.throws(() => readDashboardSnapshot(firstFile), /大小/u);
});

test("sessions pin their selected initial snapshot and independently persist, reorder, and reset", (t) => {
  const { directory, registry, first, second, firstFile, secondFile } = fixture(t);
  const artifacts = new ArtifactStore(path.join(directory, "artifacts"));
  const calls: string[] = [];
  const sessions = new SessionDashboardStore(artifacts, (id) => {
    calls.push(id);
    return registry.loadInitial(id.endsWith("beta") ? "production" : "default");
  });
  assert.deepEqual(sessions.loadOrPreview("session-alpha"), first);
  assert.deepEqual(sessions.loadOrPreview("session-beta"), second);
  assert.equal(existsSync(path.join(artifacts.rootDir, "session-alpha")), false);
  writeDashboardSnapshot(firstFile, { ...first, dataAsOf: "2026-09-16T01:00:00.000Z" });
  writeDashboardSnapshot(secondFile, { ...second, widgets: [] });
  assert.deepEqual(sessions.loadOrPreview("session-alpha"), first);
  assert.deepEqual(sessions.loadOrPreview("session-beta"), second);
  assert.equal(sessions.loadOrPreview("session-new-alpha").dataAsOf, "2026-09-16T01:00:00.000Z");
  const edited = sessions.apply("session-alpha", { action: "remove", baseRevision: 0, widgetId: "production" });
  const reordered = sessions.apply("session-beta", { action: "reorder", baseRevision: 0,
    widgetIds: ["production", "production-table"] });
  assert.deepEqual(edited.dashboard.widgets, []);
  assert.equal(reordered.dashboard.widgets[0]?.kind, "kpi");
  assert.deepEqual(calls, ["session-alpha", "session-beta", "session-new-alpha"]);
  const restarted = new SessionDashboardStore(artifacts, () => { assert.fail("saved sessions must not reload a template"); });
  assert.deepEqual(restarted.loadOrInitialize("session-alpha"), edited.dashboard);
  assert.deepEqual(restarted.loadOrPreview("session-beta"), reordered.dashboard);
  assert.deepEqual(restarted.apply("session-alpha", { action: "reset", baseRevision: 1 }).dashboard, { ...first, revision: 2 });
  assert.deepEqual(restarted.apply("session-beta", { action: "reset", baseRevision: 1 }).dashboard, { ...second, revision: 2 });
  const document = JSON.parse(readFileSync(path.join(artifacts.rootDir, "session-alpha", "dashboard.json"), "utf8"));
  assert.deepEqual(Object.keys(document).sort(), ["baseline", "current", "schemaVersion"]);
});
