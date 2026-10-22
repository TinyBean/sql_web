import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createDashboardRegistry } from "../../src/server/dashboard/index.ts";
import { createDefaultDashboard } from "../../src/server/dashboard/default/template.ts";
import { writeDefaultDashboard } from "../../src/server/dashboard/default/index.ts";
import { createAnalysisDashboardDefinition } from "../../src/server/dashboard/analysis/index.ts";
import { createAnalysisDashboard } from "../../src/server/dashboard/analysis/template.ts";
import { projectAnalysisDashboard } from "../../src/server/dashboard/analysis/calculate/index.ts";
import type { DashboardUpdateContext } from "../../src/server/dashboard/index.ts";
import type { AppLogger } from "../../src/server/logger.ts";
import type { DashboardState } from "../../src/shared/dashboard.ts";

const now = new Date("2026-10-20T01:00:00.000Z");
const ids = ["improvement-actions-day-2026", "improvement-actions-week-2026",
  "improvement-actions-month-2026", "improvement-actions-quarter-2026"];

test("analysis dashboard selects day/week/month/quarter cards by ID and isolates every returned snapshot", () => {
  const original = createDefaultDashboard(now);
  const source = { ...original, dateRange: { start: "2026-01-01", end: "2026-10-19" },
    widgets: original.widgets.map((widget, index) => ids.includes(widget.id) ? {
      ...widget, title: widget.title + "（本期）", subtitle: "最新分析", warnings: ["数据覆盖提醒"],
      metricDefinition: "本期分析口径",
      data: [{ kind: "MT", priority: 1, issue: "等待偏长", measure: "核查等待记录",
        suggested_owner: "测试工程", loss_hours: index + 0.123456 }],
    } : widget).reverse(),
  };
  const definition = createAnalysisDashboardDefinition({ loadInitial: () => source });
  assert.equal(definition.id, "analysis");
  assert.equal(definition.title, "OEE分析看板");
  assert.equal(typeof definition.update, "function");
  const state = definition.loadInitial();
  assert.deepEqual(state, { ...source, widgets: ids.map((id) => source.widgets.find((widget) => widget.id === id)) });
  assert.deepEqual(state.widgets.map((widget) => widget.kind), Array(4).fill("table"));
  const first = state.widgets[0]!;
  assert.equal(first.kind, "table");
  if (first.kind !== "table") return;
  const originalHours = first.data[0]!["loss_hours"];
  Reflect.set(first.data[0]!, "loss_hours", -1);
  Reflect.set(first.warnings, "0", "changed");
  Reflect.set(first.encoding.columns[0]!, "label", "changed");
  Reflect.set(state.dateRange, "end", "2026-10-01");
  const next = definition.loadInitial();
  assert.equal(next.widgets[0]!.data[0]?.["loss_hours"], originalHours);
  assert.deepEqual(next.widgets[0]!.warnings, ["数据覆盖提醒"]);
  assert.deepEqual(next.dateRange, source.dateRange);
  assert.deepEqual(next.widgets[0]!.encoding, source.widgets.find((widget) => widget.id === first.id)!.encoding);
  assert.deepEqual(createAnalysisDashboard(now), { ...original, widgets: ids.map((id) => original.widgets.find((widget) => widget.id === id)) });
});

test("analysis projection retains its layout and encoding and rejects absent or mismatched cards", () => {
  const source = createDefaultDashboard(now);
  const first = source.widgets.find((widget) => widget.id === ids[0])!;
  assert.equal(first.kind, "table");
  if (first.kind !== "table") return;
  const changed = { ...first, size: "wide" as const, format: { unit: "other", precision: 0 },
    encoding: { columns: [{ key: "other", label: "other" }] } };
  const others = source.widgets.filter((widget) => widget.id !== first.id);
  const projected = projectAnalysisDashboard({ ...source, widgets: [changed, ...others] });
  assert.deepEqual(projected.widgets[0], first);
  assert.throws(() => projectAnalysisDashboard({ ...source, widgets: others }), /所需卡片/u);
  const wrongType = { ...first, kind: "kpi" as const, encoding: { value: "value", comparison: null } };
  assert.throws(() => projectAnalysisDashboard({ ...source, widgets: [wrongType, ...others] }), /所需卡片/u);
});

test("registered analysis dashboard follows default publication and falls back to four waiting cards", (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: now.getTime() });
  const root = mkdtempSync(path.join(tmpdir(), "analysis-dashboard-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const defaultDashboardPath = path.join(root, "default.json");
  const registry = createDashboardRegistry({ defaultDashboardPath });
  const empty = createAnalysisDashboard(now);
  assert.deepEqual(registry.list().map(({ id, title }) => ({ id, title })), [
    { id: "default", title: "OEE综合看板" }, { id: "analysis", title: "OEE分析看板" },
  ]);
  assert.equal(registry.loadInitial().widgets.length, 13);
  assert.equal(typeof registry.list().find((definition) => definition.id === "analysis")?.update, "function");
  assert.deepEqual(registry.loadInitial("analysis"), empty);
  assert.ok(empty.widgets.every((widget) => widget.data.length === 0 && widget.warnings.some((warning) => warning.includes("等待每日任务"))));
  for (const invalid of ["{broken", JSON.stringify({ ...createDefaultDashboard(now), widgets: [] })]) {
    writeFileSync(defaultDashboardPath, invalid);
    assert.deepEqual(registry.loadInitial("analysis"), empty);
  }
  const published = { ...createDefaultDashboard(new Date("2026-10-21T01:00:00.000Z")),
    dateRange: { start: "2026-01-01", end: "2026-10-20" } };
  writeDefaultDashboard(defaultDashboardPath, published);
  assert.deepEqual(registry.loadInitial("analysis"), { ...published, widgets: ids.map((id) => published.widgets.find((widget) => widget.id === id)) });
  assert.deepEqual(empty, createAnalysisDashboard(now));
});

test("analysis updates only this run's published projection and carries analysis and sync warnings", async () => {
  const events: string[] = [];
  const logger: AppLogger = { info(event) { events.push(event); }, warn() {}, error() {}, child() { return this; } };
  const context: DashboardUpdateContext = {
    databasePath: "/unused.sqlite", throughDate: "2026-10-19", now, syncWarnings: [], runId: "test-run", logger,
  };
  const original = createDefaultDashboard(now);
  let source: DashboardState = { ...original, dateRange: { start: "2026-01-01", end: context.throughDate },
    widgets: original.widgets.map((widget) => ({ ...widget, warnings: [] })),
  };
  const definition = createAnalysisDashboardDefinition({ loadInitial: () => source });
  const success = await definition.update!(context);
  assert.equal(success.status, "completed");
  assert.equal(success.published, true);
  assert.equal(success.dataAsOf, context.now.toISOString());
  assert.deepEqual(success.details, { sourceDashboardId: "default", widgetCount: 4 });
  assert.deepEqual(definition.loadInitial(), projectAnalysisDashboard(source));
  assert.deepEqual(events, ["daily.dashboard.published"]);

  // Numeric cards outside this projection do not degrade the analysis cards.
  source = { ...source, widgets: source.widgets.map((widget) => ({
    ...widget, warnings: ids.includes(widget.id) ? [] : ["指标暂不可用"],
  })) };
  assert.equal((await definition.update!(context)).status, "completed");
  source = { ...source, widgets: source.widgets.map((widget) => ({
    ...widget, warnings: widget.id === ids[0] ? ["本次分析暂不可用"] : widget.warnings,
  })) };
  const warning = await definition.update!({ ...context, syncWarnings: ["同步缺日"] });
  assert.equal(warning.status, "completed_with_warnings");
  assert.equal(warning.published, true);
  assert.equal(warning.reason, "同步缺日;本次分析暂不可用");
  assert.deepEqual(definition.loadInitial().widgets[0]!.warnings, ["本次分析暂不可用"]);

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
  source = { ...latest, widgets: latest.widgets.filter((widget) => widget.id !== ids[0]) };
  await assert.rejects(definition.update!(context), /所需卡片/u);
});
