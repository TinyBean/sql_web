import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { Value } from "typebox/value";
import { createDefaultDashboard } from "../../src/server/dashboard/default/template.ts";
import { createDashboardRegistry, DashboardRegistry } from "../../src/server/dashboard/index.ts";
import { loadUserDashboards } from "../../src/server/dashboard/user-dashboards.ts";
import { SessionDashboardStore, DashboardConflictError } from "../../src/server/agent/session-dashboard.ts";
import { ArtifactStore } from "../../src/server/tool/artifact-store.ts";
import { createDashboardTools } from "../../src/server/tool/dashboard-tools.ts";
import type { SessionDashboard } from "../../src/shared/dashboard.ts";

function fixture(t: TestContext) {
  const directory = mkdtempSync(path.join(tmpdir(), "multi-dashboards-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const state = createDefaultDashboard(new Date("2026-10-01T00:00:00Z"));
  const values: SessionDashboard[] = [
    { id: "default", title: "完整看板", state },
    { id: "overview", title: "概览看板", state: { ...state, widgets: state.widgets.slice(0, 4) } },
  ];
  const identities = () => values.map(({ id, title }) => ({ id, title }));
  const artifacts = new ArtifactStore(path.join(directory, "artifacts"));
  const store = new SessionDashboardStore(artifacts, () => values, identities);
  return { directory, values, identities, artifacts, store };
}

const sessionId = "multi-dashboard-session";

test("account bindings preserve order, support legacy config formats, and reject ambiguous or invalid configuration", (t) => {
  const { directory } = fixture(t);
  const registry = createDashboardRegistry();
  const file = path.join(directory, "users.json");
  const load = (value: unknown) => {
    writeFileSync(file, JSON.stringify(value));
    return loadUserDashboards(file, registry);
  };
  const resolve = load({ defaultDashboards: ["default"], users: { Alice: ["overview", "default"] } });
  assert.deepEqual(resolve(" ALICE "), ["overview", "default"]);
  assert.deepEqual(resolve("bob"), ["default"]);
  assert.ok(Object.isFrozen(resolve("alice")));
  assert.deepEqual(load({ defaultDashboard: "overview", users: { alice: "default" } })("bob"), ["overview"]);
  assert.throws(() => registry.loadInitial("test"), /未知看板/u);
  assert.throws(() => load({ defaultDashboard: "test", users: {} }), /未知看板/u);
  assert.throws(() => load({ defaultDashboards: ["default"], users: { alice: "test" } }), /未知看板/u);
  for (const defaults of [[], ["missing"], ["default", "default"], ["test", "overview"], [1], null]) {
    assert.throws(() => load({ defaultDashboards: defaults, users: {} }));
  }
  assert.throws(() => load({ defaultDashboard: "default", defaultDashboards: ["default"], users: {} }), /只能/u);
  assert.throws(() => load({ defaultDashboards: "default", users: {} }));
  assert.throws(() => load({ defaultDashboards: ["default"], users: { Alice: "default", alice: "overview" } }), /重复账号/u);
  assert.throws(() => load({ defaultDashboards: ["default"], users: { alice: [] } }), /不能为空/u);
  assert.equal(new DashboardRegistry([{ id: "custom", loadInitial: () => registry.loadInitial() }]).title("custom"), "custom");
});

test("boards pin separate baselines and revisions, including identical card IDs, across a restart", (t) => {
  const { values, identities, artifacts, store } = fixture(t);
  const original = structuredClone(values);
  assert.deepEqual(store.listOrPreview(sessionId), original);
  values[0] = { ...values[0]!, state: { ...values[0]!.state, widgets: [] } };
  store.listOrInitialize(sessionId);
  const widgetId = original[0]!.state.widgets[0]!.id;
  store.apply(sessionId, { action: "remove", baseRevision: 0, widgetId }, "default");
  assert.deepEqual(store.loadOrPreview(sessionId, "overview"), original[1]!.state);
  store.apply(sessionId, { action: "remove", baseRevision: 0, widgetId }, "overview");
  assert.throws(() => store.apply(sessionId, { action: "reset", baseRevision: 0 }, "default"), DashboardConflictError);
  assert.throws(() => store.apply(sessionId, { action: "reset", baseRevision: 1 }, "missing"), /不存在/u);
  const restarted = new SessionDashboardStore(artifacts, () => { throw new Error("must use saved baseline"); }, identities);
  const reset = restarted.apply(sessionId, { action: "reset", baseRevision: 1 }, "default").dashboard;
  assert.deepEqual(reset, { ...original[0]!.state, revision: 2 });
  assert.equal(restarted.loadOrPreview(sessionId, "overview").revision, 1);
  assert.equal(restarted.loadOrPreview(sessionId, "overview").widgets.length, 3);
  assert.throws(() => restarted.loadOrPreview(sessionId), /必须指定/u);
});

test("dashboard tools read summaries or full data and submit changes to explicitly selected boards", async (t) => {
  const { store } = fixture(t);
  const [get, update] = createDashboardTools(store, sessionId);
  assert.ok(get && update);
  const executeGet = (args: unknown) => get.execute("read", args as never, undefined, undefined, undefined as never);
  const content = (await executeGet({})).content[0]!;
  assert.equal(content.type, "text");
  const summary = JSON.parse(content.type === "text" ? content.text : "{}");
  assert.deepEqual(summary.dashboards.map((item: { id: string }) => item.id), ["default", "overview"]);
  assert.equal("data" in summary.dashboards[0].widgets[0], false);
  const detail = await executeGet({ dashboard_ids: ["overview"], include_data: true });
  assert.match(JSON.stringify(detail.content), /overall_effective_oee_percent/u);
  await assert.rejects(executeGet({ dashboard_ids: ["missing"] }), /不存在/u);
  assert.equal(Value.Check(update.parameters, { action: "reset", base_revision: 0 }), false);
  const data = { columns: ["value"], rows: [{ value: 42 }] };
  store.setActiveDashboard(sessionId, "overview");
  for (const dashboard_id of ["default", "overview"]) {
    const events: unknown[] = [];
    const result = await update.execute("write", { dashboard_id, action: "upsert", base_revision: 0, data,
      date_range: { start: null, end: null }, widget: { id: "shared-metric", kind: "kpi", title: dashboard_id,
        subtitle: "", encoding: { value: "value", comparison: null }, format: { unit: "", precision: 2 },
        metric_definition: "测试数据", warnings: [] } } as never, undefined, (event) => events.push(event), undefined as never);
    assert.equal(result.details?.dashboardId, dashboard_id);
    assert.match(JSON.stringify(events), new RegExp('"dashboardId":"' + dashboard_id + '"', "u"));
  }
  assert.equal(store.activeDashboardId(sessionId), "overview", "writes must preserve the request's default target");
  assert.equal(store.loadOrPreview(sessionId, "default").widgets.at(-1)!.title, "default");
  assert.equal(store.loadOrPreview(sessionId, "overview").widgets.at(-1)!.title, "overview");
});

test("legacy snapshots keep their original binding and bytes until their first edit", (t) => {
  const { store, values, artifacts } = fixture(t);
  store.initialize(sessionId, values);
  const filename = path.join(artifacts.rootDir, sessionId, "dashboard.json");
  const legacy = JSON.stringify({ schemaVersion: 1, baseline: values[1]!.state,
    current: { ...values[1]!.state, revision: 3, widgets: [] } });
  writeFileSync(filename, legacy);
  const old = new SessionDashboardStore(artifacts, () => { throw new Error("must not reload"); },
    () => [{ id: "overview", title: "旧概览" }]);
  assert.deepEqual(old.listOrInitialize(sessionId).map((item) => item.id), ["overview"]);
  assert.equal(readFileSync(filename, "utf8"), legacy);
  assert.equal(old.apply(sessionId, { action: "reset", baseRevision: 3 }, "overview").dashboard.widgets.length, 4);
  const document = JSON.parse(readFileSync(filename, "utf8"));
  assert.equal(document.schemaVersion, 2);
  assert.equal(document.dashboards[0].id, "overview");
});

test("aggregate snapshots can exceed the old file limit while each board retains its size budget", (t) => {
  const { store, values, artifacts } = fixture(t);
  const table = (length: number) => ({ id: "large-table", title: "明细", subtitle: "", kind: "table" as const,
    size: "wide" as const, encoding: { columns: [{ key: "value", label: "内容" }] }, data: [{ value: "x".repeat(length) }],
    format: { unit: "", precision: 2 }, metricDefinition: "测试容量", warnings: [] });
  const large = values.map((item) => ({ ...item, state: { ...item.state, widgets: [table(650_000)] } }));
  store.initialize(sessionId, large);
  assert.ok(Buffer.byteLength(readFileSync(path.join(artifacts.rootDir, sessionId, "dashboard.json"))) > 2 * 1024 * 1024);
  const restarted = new SessionDashboardStore(artifacts, () => { throw new Error("must read saved data"); });
  assert.deepEqual(restarted.listOrPreview(sessionId), large);
  assert.throws(() => store.initialize(sessionId, [{ ...large[0]!, state: { ...large[0]!.state, widgets: [table(1_100_000)] } }]), /大小|不能超过/u);
  assert.deepEqual(restarted.listOrPreview(sessionId), large, "an oversized write must preserve the existing file");
});
