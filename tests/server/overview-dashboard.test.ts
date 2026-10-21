import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createDashboardRegistry } from "../../src/server/dashboard/index.ts";
import { createDefaultDashboard } from "../../src/server/dashboard/default/template.ts";
import { writeDefaultDashboard } from "../../src/server/dashboard/default/index.ts";
import { createOverviewDashboardDefinition } from "../../src/server/dashboard/overview/index.ts";
import { createOverviewDashboard } from "../../src/server/dashboard/overview/template.ts";
import { projectOverviewDashboard } from "../../src/server/dashboard/overview/calculate/index.ts";
import type { DashboardUpdateContext } from "../../src/server/dashboard/index.ts";
import type { AppLogger } from "../../src/server/logger.ts";
import type { DashboardState } from "../../src/shared/dashboard.ts";

const now = new Date("2026-10-20T01:00:00.000Z");
const ids = ["mt-effective-oee-overview", "mt-oee-overview", "st-effective-oee-overview", "st-oee-overview"];

test("overview dashboard selects values by ID in its own order and isolates every returned snapshot", () => {
  const original = createDefaultDashboard(now);
  const source = { ...original, dateRange: { start: "2026-01-01", end: "2026-10-19" },
    widgets: original.widgets.map((widget, index) => widget.kind === "overview" ? {
      ...widget, subtitle: "最新业务指标", warnings: ["数据覆盖提醒"],
      data: [{ ...widget.data[0], [widget.encoding.value]: index + 0.123456 }],
      encoding: { ...widget.encoding, description: "覆盖说明 " + index },
    } : widget).reverse(),
  };
  const definition = createOverviewDashboardDefinition({ loadInitial: () => source });
  assert.equal(definition.id, "overview");
  assert.equal(typeof definition.update, "function");
  const state = definition.loadInitial();
  assert.deepEqual(state, { ...source, widgets: ids.map((id) => source.widgets.find((widget) => widget.id === id)) });
  assert.deepEqual(state.widgets.map((widget) => widget.kind), Array(4).fill("overview"));
  const first = state.widgets[0]!;
  assert.equal(first.kind, "overview");
  if (first.kind !== "overview") return;
  Reflect.set(first.data[0]!, first.encoding.value, -1);
  Reflect.set(first.warnings, "0", "changed");
  Reflect.set(first.encoding.gauges[0]!, "name", "changed");
  Reflect.set(state.dateRange, "end", "2026-10-01");
  const next = definition.loadInitial();
  assert.equal(next.widgets[0]!.data[0]?.[first.encoding.value], 0.123456);
  assert.deepEqual(next.widgets[0]!.warnings, ["数据覆盖提醒"]);
  assert.deepEqual(next.dateRange, source.dateRange);
  assert.deepEqual(next.widgets[0]!.encoding, source.widgets.find((widget) => widget.id === first.id)!.encoding);
  assert.deepEqual(createOverviewDashboard(now), { ...original, widgets: ids.map((id) => original.widgets.find((widget) => widget.id === id)) });
});

test("overview projection retains its layout and encoding and rejects absent or mismatched cards", () => {
  const source = createDefaultDashboard(now);
  const first = source.widgets[0]!;
  assert.equal(first.kind, "overview");
  if (first.kind !== "overview") return;
  const changed = { ...first, size: "wide" as const, format: { unit: "other", precision: 0 },
    encoding: { ...first.encoding, label: "other", description: "latest coverage" } };
  const projected = projectOverviewDashboard({ ...source, widgets: [changed, ...source.widgets.slice(1)] });
  assert.deepEqual(projected.widgets[0], { ...first, encoding: { ...first.encoding, description: "latest coverage" } });
  assert.throws(() => projectOverviewDashboard({ ...source, widgets: source.widgets.slice(1) }), /所需卡片/u);
  const wrongType = { ...first, kind: "kpi" as const, encoding: { value: "value", comparison: null } };
  assert.throws(() => projectOverviewDashboard({ ...source, widgets: [wrongType, ...source.widgets.slice(1)] }), /所需卡片/u);
});

test("registered overview dashboard follows default publication and falls back to four waiting cards", (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: now.getTime() });
  const root = mkdtempSync(path.join(tmpdir(), "overview-dashboard-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const defaultDashboardPath = path.join(root, "default.json");
  const registry = createDashboardRegistry({ defaultDashboardPath });
  const empty = createOverviewDashboard(now);
  assert.equal(typeof registry.list().find((definition) => definition.id === "overview")?.update, "function");
  assert.deepEqual(registry.loadInitial("overview"), empty);
  for (const invalid of ["{broken", JSON.stringify({ ...createDefaultDashboard(now), widgets: [] })]) {
    writeFileSync(defaultDashboardPath, invalid);
    assert.deepEqual(registry.loadInitial("overview"), empty);
  }
  const published = { ...createDefaultDashboard(new Date("2026-10-21T01:00:00.000Z")),
    dateRange: { start: "2026-01-01", end: "2026-10-20" } };
  writeDefaultDashboard(defaultDashboardPath, published);
  assert.deepEqual(registry.loadInitial("overview"), { ...published, widgets: ids.map((id) => published.widgets.find((widget) => widget.id === id)) });
  assert.deepEqual(empty, createOverviewDashboard(now));
});

test("overview updates only this run's published projection and carries overview and sync warnings", async () => {
  const events: string[] = [];
  const logger: AppLogger = { info(event) { events.push(event); }, warn() {}, error() {}, child() { return this; } };
  const context: DashboardUpdateContext = {
    databasePath: "/unused.sqlite", throughDate: "2026-10-19", now, syncWarnings: [], runId: "test-run", logger,
  };
  const original = createDefaultDashboard(now);
  let source: DashboardState = { ...original, dateRange: { start: "2026-01-01", end: context.throughDate },
    widgets: original.widgets.map((widget) => ({ ...widget, warnings: [] })),
  };
  const definition = createOverviewDashboardDefinition({ loadInitial: () => source });
  const success = await definition.update!(context);
  assert.equal(success.status, "completed");
  assert.equal(success.published, true);
  assert.equal(success.dataAsOf, context.now.toISOString());
  assert.deepEqual(success.details, { sourceDashboardId: "default", widgetCount: 4 });
  assert.deepEqual(definition.loadInitial(), projectOverviewDashboard(source));
  assert.deepEqual(events, ["daily.dashboard.published"]);

  // Analysis warnings on cards outside this projection do not degrade overview's numeric cards.
  source = { ...source, widgets: source.widgets.map((widget) => ({
    ...widget, warnings: widget.kind === "overview" ? [] : ["分析暂不可用"],
  })) };
  assert.equal((await definition.update!(context)).status, "completed");
  source = { ...source, widgets: source.widgets.map((widget, index) => ({
    ...widget, warnings: index === 0 ? ["数据覆盖不完整"] : widget.warnings,
  })) };
  const warning = await definition.update!({ ...context, syncWarnings: ["同步缺日"] });
  assert.equal(warning.status, "completed_with_warnings");
  assert.equal(warning.published, true);
  assert.equal(warning.reason, "同步缺日;数据覆盖不完整");

  const latest = source;
  for (const previous of [
    { ...latest, dataAsOf: new Date(now.getTime() - 1).toISOString() },
    { ...latest, dateRange: { start: "2026-01-01", end: "2026-10-18" } },
    { ...latest, dateRange: { start: null, end: null } },
  ]) {
    source = previous;
    const before = events.length;
    const skipped = await definition.update!(context);
    assert.equal(skipped.status, "skipped");
    assert.equal(skipped.published, false);
    assert.equal(skipped.dataAsOf, null);
    assert.match(skipped.reason!, /本次未发布/u);
    assert.equal(events.length, before);
  }
  source = { ...latest, widgets: latest.widgets.slice(1) };
  await assert.rejects(definition.update!(context), /所需卡片/u);
});
