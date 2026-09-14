import assert from "node:assert/strict";
import test from "node:test";
import {
  dashboardDropTarget,
  type DashboardLayout,
  type DashboardRect,
} from "../../src/client/dashboard-drag.ts";

function layout(order: readonly string[], spans: Record<string, number> = {}): DashboardLayout {
  const widgets = new Map<string, DashboardRect>();
  let column = 0;
  let row = 0;
  for (const id of order) {
    const span = spans[id] ?? 1;
    if (column + span > 4) { column = 0; row += 1; }
    widgets.set(id, { left: column * 100, top: row * 100, width: span * 100 - 10, height: 90 });
    column += span;
  }
  return { bounds: { left: 0, top: 0, width: 390, height: row * 100 + 90 }, widgets };
}

test("keeps the source slot and adjacent gap in mixed-width grids", () => {
  const order = ["a", "b", "c", "d"];
  const mixed = layout(order, { a: 4, d: 2 });
  for (const point of [{ x: 110, y: 0 }, { x: 380, y: 80 }, { x: 110, y: 94 }]) {
    assert.equal(dashboardDropTarget(mixed, order, "a", point, null), null);
  }
  assert.deepEqual(dashboardDropTarget(mixed, order, "a", { x: 110, y: 180 }, null), {
    widgetId: "c", after: true, direction: 1, point: { x: 110, y: 180 },
  });
});

test("uses horizontal midpoints within a row and vertical midpoints across rows", () => {
  const order = ["a", "b", "c"];
  assert.equal(dashboardDropTarget(layout(order), order, "a", { x: 180, y: 10 }, null)?.widgetId, "b");
  assert.equal(dashboardDropTarget(layout(order), order, "c", { x: 10, y: 80 }, null)?.after, false);
  const rows = layout(order, { a: 4, b: 4, c: 4 });
  assert.equal(dashboardDropTarget(rows, order, "a", { x: 10, y: 180 }, null)?.after, true);
  assert.equal(dashboardDropTarget(rows, order, "c", { x: 380, y: 110 }, null)?.after, false);
});

test("midpoint jitter, unchanged input, and tiny reversals cannot reorder", () => {
  const order = ["a", "b"];
  for (const x of [134, 144, 145, 146, 156]) {
    assert.equal(dashboardDropTarget(layout(order), order, "a", { x, y: 20 }, null), null);
  }
  const forward = dashboardDropTarget(layout(order), order, "a", { x: 180, y: 20 }, null);
  assert.ok(forward);
  const reversed = ["b", "a"];
  // Even if another layout change moves every slot away, a stationary pointer is inert.
  const shifted: DashboardLayout = {
    bounds: { left: 0, top: 0, width: 390, height: 290 },
    widgets: new Map([
      ["a", { left: 0, top: 200, width: 390, height: 90 }],
      ["b", { left: 100, top: 100, width: 90, height: 90 }],
    ]),
  };
  assert.equal(dashboardDropTarget(shifted, reversed, "a", forward.point, forward), null);
  const lastMove = { point: { x: 20, y: 20 }, direction: 1 };
  assert.equal(dashboardDropTarget(layout(reversed), reversed, "a", { x: 25, y: 20 }, lastMove), null);
  assert.equal(dashboardDropTarget(layout(reversed), reversed, "a", { x: 25, y: 60 }, lastMove), null,
    "vertical motion alone must not reverse a horizontal reorder");
  assert.equal(dashboardDropTarget(layout(reversed), reversed, "a", { x: 5, y: 20 }, lastMove)?.direction, -1);
});

test("outside the grid, missing widgets, and a single card keep the current order", () => {
  const order = ["a", "b"];
  for (const point of [{ x: -1, y: 20 }, { x: 500, y: 20 }, { x: 180, y: -1 }, { x: 180, y: 100 }]) {
    assert.equal(dashboardDropTarget(layout(order), order, "a", point, null), null);
  }
  assert.equal(dashboardDropTarget(layout(["a"]), ["a"], "a", { x: 180, y: 20 }, null), null);
  assert.equal(dashboardDropTarget(layout(["b"]), order, "a", { x: 20, y: 20 }, null), null);
});
