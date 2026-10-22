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
    { id: "default", title: "OEE综合看板", state },
    { id: "analysis", title: "OEE分析看板", state: createDashboardRegistry().loadInitial("analysis") },
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
  const resolve = load({ defaultDashboards: ["default"], users: { Alice: ["analysis", "default"] } });
  assert.deepEqual(resolve(" ALICE "), ["analysis", "default"]);
  assert.deepEqual(resolve("bob"), ["default"]);
  assert.ok(Object.isFrozen(resolve("alice")));
  assert.deepEqual(load({ defaultDashboard: "analysis", users: { alice: "default" } })("bob"), ["analysis"]);
  assert.deepEqual(load({ defaultDashboards: ["analysis", "default"], users: {} })("bob"), ["analysis", "default"]);
  assert.throws(() => registry.loadInitial("overview"), /未知看板/u);
  assert.throws(() => load({ defaultDashboard: "overview", users: {} }), /未知看板/u);
  assert.throws(() => load({ defaultDashboards: ["default"], users: { alice: "overview" } }), /未知看板/u);
  assert.throws(() => load({ defaultDashboards: ["analysis", "analysis"], users: {} }), /重复看板/u);
  assert.throws(() => registry.loadInitial("test"), /未知看板/u);
  assert.throws(() => load({ defaultDashboard: "test", users: {} }), /未知看板/u);
  assert.throws(() => load({ defaultDashboards: ["default"], users: { alice: "test" } }), /未知看板/u);
  for (const defaults of [[], ["missing"], ["default", "default"], ["test", "overview"], [1], null]) {
    assert.throws(() => load({ defaultDashboards: defaults, users: {} }));
  }
  assert.throws(() => load({ defaultDashboard: "default", defaultDashboards: ["default"], users: {} }), /只能/u);
  assert.throws(() => load({ defaultDashboards: "default", users: {} }));
  assert.throws(() => load({ defaultDashboards: ["default"], users: { Alice: "default", alice: "analysis" } }), /重复账号/u);
  assert.throws(() => load({ defaultDashboards: ["default"], users: { alice: [] } }), /不能为空/u);
  assert.equal(new DashboardRegistry([{ id: "custom", loadInitial: () => registry.loadInitial() }]).title("custom"), "custom");
});

test("boards pin separate baselines and revisions, including identical card IDs, across a restart", (t) => {
  const { values, identities, artifacts, store } = fixture(t);
  const original = structuredClone(values);
  assert.deepEqual(store.listOrPreview(sessionId), original);
  values[0] = { ...values[0]!, state: { ...values[0]!.state, widgets: [] } };
  store.listOrInitialize(sessionId);
  const widgetId = original[1]!.state.widgets[0]!.id;
  store.apply(sessionId, { action: "remove", baseRevision: 0, widgetId }, "default");
  assert.deepEqual(store.loadOrPreview(sessionId, "analysis"), original[1]!.state);
  store.apply(sessionId, { action: "remove", baseRevision: 0, widgetId }, "analysis");
  assert.throws(() => store.apply(sessionId, { action: "reset", baseRevision: 0 }, "default"), DashboardConflictError);
  assert.throws(() => store.apply(sessionId, { action: "reset", baseRevision: 1 }, "missing"), /不存在/u);
  const restarted = new SessionDashboardStore(artifacts, () => { throw new Error("must use saved baseline"); }, identities);
  const reset = restarted.apply(sessionId, { action: "reset", baseRevision: 1 }, "default").dashboard;
  assert.deepEqual(reset, { ...original[0]!.state, revision: 2 });
  assert.equal(restarted.loadOrPreview(sessionId, "analysis").revision, 1);
  assert.equal(restarted.loadOrPreview(sessionId, "analysis").widgets.length, 5);
  assert.throws(() => restarted.loadOrPreview(sessionId), /必须指定/u);
});

test("saved analysis copies gain platform labels without replacing pinned facts, edits, revisions or files", async (t) => {
  const { values, identities, artifacts, store } = fixture(t);
  store.initialize(sessionId, values);
  const filename = path.join(artifacts.rootDir, sessionId, "dashboard.json");
  const savedState = (state: SessionDashboard["state"], oee: number, legacy: boolean) => ({ ...state,
    widgets: state.widgets.map((widget) => widget.kind !== "table" || !widget.id.startsWith("machine-improvement-") ? widget : {
      ...widget, title: "保留的机台分析标题", size: "medium" as const,
      encoding: { columns: widget.encoding.columns.map((column) => legacy && column.key === "machine_label" ? { key: "machine", label: "机台" } : column) },
      data: [{ kind: widget.id.includes("-mt-") ? "MT" : "ST", rank: 1,
        machine: widget.id.includes("-mt-") ? "ADH001" : "ST-UNKNOWN", oee, action_and_owner: "保留的改善建议和责任人",
        ...(!legacy ? { machine_label: widget.id.includes("-mt-") ? "T5773/ADH001" : "平台待维护/ST-UNKNOWN" } : {}) }],
    }),
  });
  const baseline = savedState(values[1]!.state, 35, true);
  const current = { ...savedState(values[1]!.state, 42, true), revision: 7 };
  const document = { schemaVersion: 2, dashboards: [
    { id: "default", title: values[0]!.title, baseline: savedState(values[0]!.state, 60, false), current: { ...savedState(values[0]!.state, 60, false), revision: 4 } },
    { id: "analysis", title: values[1]!.title, baseline, current },
  ] };
  const original = JSON.stringify(document); writeFileSync(filename, original);
  const reopened = new SessionDashboardStore(artifacts, () => { throw new Error("saved data must not reload the latest dashboard"); }, identities);
  for (const state of [reopened.loadOrPreview(sessionId, "analysis"), reopened.loadOrInitialize(sessionId, "analysis")]) {
    assert.equal(state.revision, 7); assert.equal(state.dataAsOf, current.dataAsOf);
    assert.deepEqual(state.dateRange, current.dateRange);
    for (const widget of state.widgets.slice(2)) {
      assert.equal(widget.kind, "table"); if (widget.kind !== "table") continue;
      assert.equal(widget.size, "medium"); assert.equal(widget.title, "保留的机台分析标题");
      assert.equal(widget.encoding.columns.length, 10);
      assert.deepEqual(widget.encoding.columns[2], { key: "machine_label", label: "平台/机台" });
      const row = widget.data[0]!;
      assert.equal(row["oee"], 42); assert.equal(row["action_and_owner"], "保留的改善建议和责任人");
      assert.equal(row["machine_label"], row["machine"] === "ADH001" ? "T5773/ADH001" : "平台待维护/ST-UNKNOWN");
    }
  }
  assert.equal(readFileSync(filename, "utf8"), original, "viewing an old session must not rewrite its snapshot");
  assert.equal(reopened.loadOrPreview(sessionId, "default").widgets[11]!.data[0]!["oee"], 60);
  const tools = createDashboardTools(reopened, sessionId);
  const reply = await tools[0]!.execute("read", { dashboard_ids: ["analysis"], include_data: true }, undefined, undefined, undefined as never);
  assert.match(JSON.stringify(reply.content), /T5773\/ADH001/u);
  const reset = reopened.apply(sessionId, { action: "reset", baseRevision: 7 }, "analysis").dashboard;
  assert.equal(reset.revision, 8); assert.equal(reset.widgets[2]!.data[0]!["oee"], 35);
  assert.equal(reset.widgets[2]!.data[0]!["machine_label"], "T5773/ADH001");
  assert.equal(reopened.loadOrPreview(sessionId, "default").revision, 4);
});

test("dashboard tools read summaries or full data and submit changes to explicitly selected boards", async (t) => {
  const { store } = fixture(t);
  const [get, update] = createDashboardTools(store, sessionId);
  assert.ok(get && update);
  const executeGet = (args: unknown) => get.execute("read", args as never, undefined, undefined, undefined as never);
  const content = (await executeGet({})).content[0]!;
  assert.equal(content.type, "text");
  const summary = JSON.parse(content.type === "text" ? content.text : "{}");
  assert.deepEqual(summary.dashboards.map((item: { id: string }) => item.id), ["default", "analysis"]);
  assert.equal("data" in summary.dashboards[0].widgets[0], false);
  const detail = await executeGet({ dashboard_ids: ["analysis"], include_data: true });
  assert.match(JSON.stringify(detail.content), /loss_hours/u);
  await assert.rejects(executeGet({ dashboard_ids: ["missing"] }), /不存在/u);
  assert.equal(Value.Check(update.parameters, { action: "reset", base_revision: 0 }), false);
  const data = { columns: ["value"], rows: [{ value: 42 }] };
  store.setActiveDashboard(sessionId, "analysis");
  for (const dashboard_id of ["default", "analysis"]) {
    const events: unknown[] = [];
    const result = await update.execute("write", { dashboard_id, action: "upsert", base_revision: 0, data,
      date_range: { start: null, end: null }, widget: { id: "shared-metric", kind: "kpi", title: dashboard_id,
        subtitle: "", encoding: { value: "value", comparison: null }, format: { unit: "", precision: 2 },
        metric_definition: "测试数据", warnings: [] } } as never, undefined, (event) => events.push(event), undefined as never);
    assert.equal(result.details?.dashboardId, dashboard_id);
    assert.match(JSON.stringify(events), new RegExp('"dashboardId":"' + dashboard_id + '"', "u"));
  }
  assert.equal(store.activeDashboardId(sessionId), "analysis", "writes must preserve the request's default target");
  assert.equal(store.loadOrPreview(sessionId, "default").widgets.at(-1)!.title, "default");
  assert.equal(store.loadOrPreview(sessionId, "analysis").widgets.at(-1)!.title, "analysis");
});

test("legacy snapshots keep their original binding and bytes until their first edit", (t) => {
  const { store, values, artifacts } = fixture(t);
  store.initialize(sessionId, values);
  const filename = path.join(artifacts.rootDir, sessionId, "dashboard.json");
  const baseline = values[1]!.state;
  const legacy = JSON.stringify({ schemaVersion: 1, baseline,
    current: { ...baseline, revision: 3, widgets: [] } });
  writeFileSync(filename, legacy);
  const old = new SessionDashboardStore(artifacts, () => { throw new Error("must not reload"); },
    () => [{ id: "analysis", title: "OEE分析看板" }]);
  assert.deepEqual(old.listOrInitialize(sessionId).map((item) => item.id), ["analysis"]);
  assert.equal(readFileSync(filename, "utf8"), legacy);
  assert.equal(old.apply(sessionId, { action: "reset", baseRevision: 3 }, "analysis").dashboard.widgets.length, 6);
  const document = JSON.parse(readFileSync(filename, "utf8"));
  assert.equal(document.schemaVersion, 2);
  assert.equal(document.dashboards[0].id, "analysis");
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
