import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createDashboardRegistry } from "../../src/server/dashboard/index.ts";
import { createDefaultDashboard } from "../../src/server/dashboard/default/template.ts";
import { writeDefaultDashboard } from "../../src/server/dashboard/default/index.ts";
import { createTestDashboardDefinition } from "../../src/server/dashboard/test/index.ts";
import { createTestDashboard } from "../../src/server/dashboard/test/template.ts";
import { projectTestDashboard } from "../../src/server/dashboard/test/calculate/index.ts";

const now = new Date("2026-10-20T01:00:00.000Z");
const ids = ["mt-effective-oee-overview", "mt-oee-overview", "st-effective-oee-overview", "st-oee-overview"];

test("test dashboard selects values by ID in its own order and isolates every returned snapshot", () => {
  const original = createDefaultDashboard(now);
  const source = { ...original, dateRange: { start: "2026-01-01", end: "2026-10-19" },
    widgets: original.widgets.map((widget, index) => widget.kind === "overview" ? {
      ...widget, subtitle: "最新业务指标", warnings: ["数据覆盖提醒"],
      data: [{ ...widget.data[0], [widget.encoding.value]: index + 0.123456 }],
      encoding: { ...widget.encoding, description: "覆盖说明 " + index },
    } : widget).reverse(),
  };
  const definition = createTestDashboardDefinition({ loadInitial: () => source });
  assert.equal(definition.id, "test");
  assert.equal(definition.update, undefined);
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
  assert.deepEqual(createTestDashboard(now), { ...original, widgets: ids.map((id) => original.widgets.find((widget) => widget.id === id)) });
});

test("test projection retains its layout and encoding and rejects absent or mismatched cards", () => {
  const source = createDefaultDashboard(now);
  const first = source.widgets[0]!;
  assert.equal(first.kind, "overview");
  if (first.kind !== "overview") return;
  const changed = { ...first, size: "wide" as const, format: { unit: "other", precision: 0 },
    encoding: { ...first.encoding, label: "other", description: "latest coverage" } };
  const projected = projectTestDashboard({ ...source, widgets: [changed, ...source.widgets.slice(1)] });
  assert.deepEqual(projected.widgets[0], { ...first, encoding: { ...first.encoding, description: "latest coverage" } });
  assert.throws(() => projectTestDashboard({ ...source, widgets: source.widgets.slice(1) }), /所需卡片/u);
  const wrongType = { ...first, kind: "kpi" as const, encoding: { value: "value", comparison: null } };
  assert.throws(() => projectTestDashboard({ ...source, widgets: [wrongType, ...source.widgets.slice(1)] }), /所需卡片/u);
});

test("registered test dashboard follows default publication and falls back to four waiting cards", (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: now.getTime() });
  const root = mkdtempSync(path.join(tmpdir(), "test-dashboard-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const defaultDashboardPath = path.join(root, "default.json");
  const registry = createDashboardRegistry({ defaultDashboardPath });
  const empty = createTestDashboard(now);
  assert.equal(registry.list().find((definition) => definition.id === "test")?.update, undefined);
  assert.deepEqual(registry.loadInitial("test"), empty);
  for (const invalid of ["{broken", JSON.stringify({ ...createDefaultDashboard(now), widgets: [] })]) {
    writeFileSync(defaultDashboardPath, invalid);
    assert.deepEqual(registry.loadInitial("test"), empty);
  }
  const published = { ...createDefaultDashboard(new Date("2026-10-21T01:00:00.000Z")),
    dateRange: { start: "2026-01-01", end: "2026-10-20" } };
  writeDefaultDashboard(defaultDashboardPath, published);
  assert.deepEqual(registry.loadInitial("test"), { ...published, widgets: ids.map((id) => published.widgets.find((widget) => widget.id === id)) });
  assert.deepEqual(empty, createTestDashboard(now));
});
