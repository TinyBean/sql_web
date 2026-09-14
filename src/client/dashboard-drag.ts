export interface DashboardRect {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

export interface DashboardLayout {
  readonly bounds: DashboardRect;
  /** Layout boxes relative to the grid, without card animation transforms. */
  readonly widgets: ReadonlyMap<string, DashboardRect>;
}

export interface DashboardDragPoint {
  readonly x: number;
  readonly y: number;
}

export interface DashboardOrderMove {
  readonly point: DashboardDragPoint;
  readonly direction: number;
}

export interface DashboardDropTarget extends DashboardOrderMove {
  readonly widgetId: string;
  readonly after: boolean;
}

const ORDER_HYSTERESIS = 12;

function distanceToRectSquared(point: DashboardDragPoint, rect: DashboardRect): number {
  const x = Math.max(rect.left - point.x, 0, point.x - rect.left - rect.width);
  const y = Math.max(rect.top - point.y, 0, point.y - rect.top - rect.height);
  return x * x + y * y;
}

export function dashboardDropTarget(
  layout: DashboardLayout,
  order: readonly string[],
  widgetId: string,
  point: DashboardDragPoint,
  previousMove: DashboardOrderMove | null,
): DashboardDropTarget | null {
  const source = layout.widgets.get(widgetId);
  if (!source || point.x < 0 || point.y < 0 ||
    point.x > layout.bounds.width || point.y > layout.bounds.height) return null;
  // The invisible source still occupies a real grid slot. Keep that slot when hit.
  if (distanceToRectSquared(point, source) === 0) return null;
  if (previousMove && Math.hypot(
    point.x - previousMove.point.x,
    point.y - previousMove.point.y,
  ) < ORDER_HYSTERESIS) return null;

  let targetId = widgetId;
  let closestDistance = distanceToRectSquared(point, source);
  for (const id of order) {
    const rect = layout.widgets.get(id);
    if (!rect || id === widgetId) continue;
    const distance = distanceToRectSquared(point, rect);
    if (distance < closestDistance) {
      closestDistance = distance;
      targetId = id;
    }
  }
  const target = layout.widgets.get(targetId);
  if (!target || targetId === widgetId) return null;
  const axis = Math.abs(target.top - source.top) < 1 ? "x" : "y";
  const midpoint = axis === "x"
    ? target.left + target.width / 2
    : target.top + target.height / 2;
  const delta = point[axis] - midpoint;
  if (Math.abs(delta) < ORDER_HYSTERESIS) return null;
  const after = delta > 0;
  const currentIndex = order.indexOf(widgetId);
  const targetIndex = order.indexOf(targetId);
  const nextIndex = targetIndex - (currentIndex < targetIndex ? 1 : 0) + (after ? 1 : 0);
  const direction = Math.sign(nextIndex - currentIndex);
  if (!direction) return null;
  // A reflow can change the candidate/axis; reversing requires actual travel back.
  if (previousMove && direction !== previousMove.direction &&
    (point[axis] - previousMove.point[axis]) * direction < ORDER_HYSTERESIS) return null;
  return { widgetId: targetId, after, direction, point };
}
