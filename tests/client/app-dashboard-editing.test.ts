/// <reference lib="dom" />

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { parseHTML } from "linkedom";
import type { DashboardState, DashboardWidget } from "../../src/shared/dashboard.ts";
import type { SerializedSession, SessionSummary } from "../../src/shared/contracts.ts";

function kpi(id: string, title: string, value: number): DashboardWidget {
  return {
    id,
    kind: "kpi",
    title,
    subtitle: "测试指标",
    size: "small",
    data: [{ value }],
    encoding: { value: "value", comparison: null },
    format: { unit: "%", precision: 1 },
    metricDefinition: "测试口径",
    warnings: [],
  };
}

function sessionWithDashboard(dashboard: DashboardState): SerializedSession {
  return {
    id: "session-edit",
    title: "编辑测试",
    model: null,
    tools: [],
    streaming: false,
    dashboard,
    messages: [{ id: "assistant-1", role: "assistant", text: "准备完成" }],
  };
}

function summary(): SessionSummary {
  return {
    id: "session-edit",
    title: "编辑测试",
    createdAt: "2026-09-08T00:00:00.000Z",
    updatedAt: "2026-09-08T00:00:00.000Z",
    messageCount: 1,
    active: true,
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

async function waitFor(condition: () => boolean, message: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (condition()) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  assert.fail(message);
}

test("edits, rolls back, removes, and locks a session dashboard", async (t) => {
  const html = readFileSync(path.join(process.cwd(), "public", "index.html"), "utf8");
  const browser = parseHTML(html);
  const { document } = browser;
  browser.matchMedia = () => ({ matches: false }) as MediaQueryList;
  let frameId = 0;
  const frames = new Map<number, FrameRequestCallback>();
  browser.requestAnimationFrame = (callback) => {
    frames.set(++frameId, callback);
    return frameId;
  };
  browser.cancelAnimationFrame = (id) => { frames.delete(id); };
  const flushFrame = (): void => {
    const pending = [...frames.values()];
    frames.clear();
    for (const callback of pending) callback(0);
  };
  const locationState = { hash: "#session=session-edit", pathname: "/", search: "" };
  const globalNames = [
    "document",
    "window",
    "location",
    "history",
    "Element",
    "HTMLElement",
    "HTMLButtonElement",
    "HTMLDivElement",
    "HTMLDetailsElement",
    "HTMLFormElement",
    "HTMLTextAreaElement",
    "SVGSVGElement",
  ] as const;
  const originals = new Map<string, PropertyDescriptor | undefined>(
    globalNames.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]),
  );
  const expose = (name: string, value: unknown): void => {
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  };
  expose("document", document);
  expose("window", browser);
  expose("location", locationState);
  expose("history", { replaceState() {} });
  for (const name of globalNames.slice(4)) expose(name, browser[name]);
  expose("HTMLFormElement", document.querySelector("#composer")?.constructor);
  expose("HTMLTextAreaElement", document.querySelector("#questionInput")?.constructor);

  let dashboard: DashboardState = {
    schemaVersion: 1,
    revision: 0,
    dataAsOf: "2026-09-08T00:00:00.000Z",
    dateRange: { start: "2026-09-01", end: "2026-09-08" },
    widgets: [kpi("kpi-a", "指标 A", 1), kpi("kpi-b", "指标 B", 2)],
  };
  const edits: Array<Record<string, unknown>> = [];
  let failNextEdit = true;
  let reloads = 0;
  let streamController: ReadableStreamDefaultController<Uint8Array> | undefined;
  const encoder = new TextEncoder();
  const originalFetch = globalThis.fetch;
  expose("fetch", async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.pathname : input.url;
    const method = init.method ?? "GET";
    if (url === "/api/sessions" && method === "GET") return jsonResponse({ sessions: [summary()] });
    if (url === "/api/sessions/session-edit" && method === "GET") {
      reloads += 1;
      return jsonResponse(sessionWithDashboard(dashboard));
    }
    if (url === "/api/sessions/session-other" && method === "GET") {
      return jsonResponse({
        ...sessionWithDashboard({ ...dashboard, widgets: [] }),
        id: "session-other", title: "其他会话",
      });
    }
    if (url === "/api/sessions/session-edit/dashboard" && method === "PATCH") {
      const request = JSON.parse(String(init.body)) as Record<string, unknown>;
      edits.push(request);
      if (failNextEdit) {
        failNextEdit = false;
        return jsonResponse({ error: "看板版本已变化", requestId: "request-conflict" }, 409);
      }
      if (request["action"] === "reorder") {
        const byId = new Map(dashboard.widgets.map((widget) => [widget.id, widget]));
        dashboard = {
          ...dashboard,
          revision: dashboard.revision + 1,
          widgets: (request["widgetIds"] as string[]).map((id) => byId.get(id) as DashboardWidget),
        };
      } else if (request["action"] === "remove") {
        dashboard = {
          ...dashboard,
          revision: dashboard.revision + 1,
          widgets: dashboard.widgets.filter((widget) => widget.id !== request["widgetId"]),
        };
      }
      return jsonResponse({ dashboard });
    }
    if (url === "/api/sessions/session-edit/messages" && method === "POST") {
      return new Response(new ReadableStream<Uint8Array>({
        start(controller) { streamController = controller; },
      }), { status: 200, headers: { "Content-Type": "text/event-stream" } });
    }
    throw new Error(`Unexpected request: ${method} ${url}`);
  });

  t.after(() => {
    Object.defineProperty(globalThis, "fetch", {
      configurable: true,
      writable: true,
      value: originalFetch,
    });
    for (const [name, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
  });

  await import(pathToFileURL(path.join(
    process.cwd(),
    "public",
    "generated",
    "client",
    "app.js",
  )).href);
  const editButton = document.querySelector("#dashboardEditButton") as HTMLButtonElement;
  await waitFor(
    () => !editButton.disabled && Boolean(document.querySelector("[data-widget-id='kpi-a']")),
    "dashboard did not load",
  );
  editButton.click();
  assert.equal(editButton.getAttribute("aria-pressed"), "true");

  const firstHandle = document.querySelector("[data-drag-handle='kpi-a']") as HTMLButtonElement;
  const moveRight = new browser.Event("keydown", { bubbles: true, cancelable: true });
  Object.defineProperty(moveRight, "key", { value: "ArrowRight" });
  firstHandle.dispatchEvent(moveRight);
  assert.deepEqual(
    [...document.querySelectorAll("[data-widget-id]")].map((card) => (card as HTMLElement).dataset["widgetId"]),
    ["kpi-b", "kpi-a"],
  );
  assert.equal(edits.length, 0, "editing must remain local until the user clicks complete");

  const grid = document.querySelector("#dashboardGrid") as HTMLElement;
  let gridTop = 0;
  Object.defineProperty(grid, "getBoundingClientRect", {
    value: () => ({ left: 0, top: gridTop, width: 200, height: 90 }),
  });
  let capturedPointer: number | null = null;
  grid.setPointerCapture = (id) => { capturedPointer = id; };
  grid.hasPointerCapture = (id) => capturedPointer === id;
  grid.releasePointerCapture = () => { capturedPointer = null; };
  for (const card of grid.querySelectorAll<HTMLElement>("[data-widget-id]")) {
    Object.defineProperties(card, {
      offsetLeft: { get: () => [...grid.children].indexOf(card) * 100 },
      offsetTop: { get: () => 0 },
      offsetWidth: { get: () => 90 },
      offsetHeight: { get: () => 90 },
    });
    Object.defineProperty(card, "getBoundingClientRect", {
      configurable: true,
      value(): DOMRect {
        const cards = [...grid.querySelectorAll<HTMLElement>("[data-widget-id]")];
        const left = cards.indexOf(card) * 100 + (card.classList.contains("dragging-source") ? 500 : 0);
        return {
          x: left,
          y: 0,
          left,
          right: left + 90,
          top: 0,
          bottom: 90,
          width: 90,
          height: 90,
          toJSON: () => ({}),
        };
      },
    });
  }
  const pointerEvent = (type: string, clientX: number, clientY: number): Event => {
    const event = new browser.Event(type, { bubbles: true, cancelable: true });
    Object.defineProperties(event, {
      pointerId: { value: 7 },
      button: { value: 0 },
      isPrimary: { value: true },
      clientX: { value: clientX },
      clientY: { value: clientY },
    });
    return event;
  };
  firstHandle.dispatchEvent(pointerEvent("pointerdown", 150, 20));
  assert.equal(capturedPointer, 7, "the grid must hold pointer capture during DOM moves");
  browser.dispatchEvent(pointerEvent("pointermove", 10, 20));
  assert.equal(frames.size, 1);
  flushFrame();
  const targetCard = document.querySelector("[data-widget-id='kpi-b']") as HTMLElement;
  assert.deepEqual(
    [...document.querySelectorAll("[data-widget-id]")].map((card) => (card as HTMLElement).dataset["widgetId"]),
    ["kpi-a", "kpi-b"],
    "cards should slide into the live pointer order",
  );
  assert.equal(targetCard.classList.contains("drop-before"), true);
  assert.equal(
    document.querySelector("[data-widget-id='kpi-a']")?.classList.contains("dragging-source"),
    true,
  );
  const ghost = document.querySelector(".dashboard-drag-ghost") as HTMLElement;
  assert.ok(ghost, "a visual card should follow the pointer");
  assert.match(ghost.style.transform, /translate3d\(-40px, 0px, 0\)/u);
  const wheel = new browser.Event("wheel", { bubbles: true, cancelable: true });
  browser.dispatchEvent(wheel);
  assert.equal(wheel.defaultPrevented, false, "wheel scrolling must remain enabled while dragging");
  browser.dispatchEvent(pointerEvent("pointermove", 180, 20));
  flushFrame();
  assert.deepEqual(
    [...document.querySelectorAll("[data-widget-id]")].map((card) => (card as HTMLElement).dataset["widgetId"]),
    ["kpi-b", "kpi-a"],
    "cards should continue sliding while the pointer moves",
  );
  const draggedCard = document.querySelector("[data-widget-id='kpi-a']");
  browser.dispatchEvent(pointerEvent("pointerup", 180, 20));
  assert.equal(capturedPointer, null);
  assert.equal(edits.length, 0, "dropping must not persist or redraw the dashboard");
  assert.equal(document.querySelector("[data-widget-id='kpi-a']"), draggedCard);
  assert.deepEqual(
    [...document.querySelectorAll("[data-widget-id]")].map((card) => (card as HTMLElement).dataset["widgetId"]),
    ["kpi-b", "kpi-a"],
    "cards should remain at the local dropped position",
  );

  const order = (): Array<string | undefined> => [...grid.children]
    .map((card) => (card as HTMLElement).dataset["widgetId"]);
  const escape = (): void => {
    const event = new browser.Event("keydown", { cancelable: true });
    Object.defineProperty(event, "key", { value: "Escape" });
    browser.dispatchEvent(event);
  };
  firstHandle.dispatchEvent(pointerEvent("pointerdown", 150, 20));
  browser.dispatchEvent(pointerEvent("pointermove", 10, 20));
  browser.dispatchEvent(pointerEvent("pointermove", 170, 20));
  assert.equal(frames.size, 1, "multiple pointer events must share one frame");
  flushFrame();
  assert.deepEqual(order(), ["kpi-b", "kpi-a"], "only the latest point should be processed");
  assert.match((document.querySelector(".dashboard-drag-ghost") as HTMLElement).style.transform,
    /translate3d\(120px, 0px, 0\)/u);
  // No frame between the last move and release: pointerup must flush its own position.
  browser.dispatchEvent(pointerEvent("pointermove", 170, 20));
  browser.dispatchEvent(pointerEvent("pointerup", 10, 20));
  assert.deepEqual(order(), ["kpi-a", "kpi-b"]);
  assert.equal(frames.size, 0, "drop must cancel the pending frame");
  assert.equal(document.querySelector(".dashboard-drag-ghost"), null);
  firstHandle.dispatchEvent(pointerEvent("pointerdown", 50, 20));
  browser.dispatchEvent(pointerEvent("pointermove", 180, 20));
  browser.dispatchEvent(pointerEvent("pointerup", 180, 20));
  assert.deepEqual(order(), ["kpi-b", "kpi-a"]);

  for (const cancel of [escape,
    () => browser.dispatchEvent(new browser.Event("blur")),
    () => browser.dispatchEvent(pointerEvent("pointercancel", 10, 20)),
    () => grid.dispatchEvent(pointerEvent("lostpointercapture", 10, 20)),
  ]) {
    firstHandle.dispatchEvent(pointerEvent("pointerdown", 150, 20));
    browser.dispatchEvent(pointerEvent("pointermove", 10, 20));
    flushFrame();
    assert.deepEqual(order(), ["kpi-a", "kpi-b"]);
    browser.dispatchEvent(pointerEvent("pointermove", 15, 20));
    cancel();
    flushFrame();
    assert.deepEqual(order(), ["kpi-b", "kpi-a"], "cancel must restore the pre-drag order");
    assert.equal(document.querySelector(".dashboard-drag-ghost"), null);
    assert.equal(document.querySelector(".dragging-source"), null);
    assert.equal(capturedPointer, null);
  }

  firstHandle.dispatchEvent(pointerEvent("pointerdown", 150, 20));
  browser.dispatchEvent(pointerEvent("pointermove", 10, -20));
  flushFrame();
  assert.deepEqual(order(), ["kpi-b", "kpi-a"], "outside the grid retains the last order");
  gridTop = -40;
  browser.dispatchEvent(new browser.Event("scroll"));
  flushFrame();
  assert.deepEqual(order(), ["kpi-a", "kpi-b"], "scroll must refresh layout with a stationary pointer");
  for (let index = 0; index < 5; index += 1) {
    browser.dispatchEvent(pointerEvent("pointermove", 10, -20));
    flushFrame();
    assert.deepEqual(order(), ["kpi-a", "kpi-b"], "stationary input must not reorder again");
  }
  escape();
  gridTop = 0;
  assert.equal(edits.length, 0, "all pointer edits remain local until completion");

  const originalAnimate = Object.getOwnPropertyDescriptor(browser.HTMLElement.prototype, "animate");
  const animations: Array<{ element: HTMLElement; keyframes: Keyframe[]; finish: () => void }> = [];
  Object.defineProperty(browser.HTMLElement.prototype, "animate", {
    configurable: true,
    value(this: HTMLElement, keyframes: Keyframe[]): Animation {
      const listeners = new Map<string, () => void>();
      animations.push({ element: this, keyframes, finish: () => listeners.get("finish")?.() });
      return {
        cancel() { listeners.get("cancel")?.(); },
        addEventListener(type: string, listener: () => void) { listeners.set(type, listener); },
      } as unknown as Animation;
    },
  });
  t.after(() => {
    if (originalAnimate) Object.defineProperty(browser.HTMLElement.prototype, "animate", originalAnimate);
    else Reflect.deleteProperty(browser.HTMLElement.prototype, "animate");
  });
  firstHandle.dispatchEvent(pointerEvent("pointerdown", 150, 20));
  browser.dispatchEvent(pointerEvent("pointermove", 10, 20));
  browser.dispatchEvent(pointerEvent("pointerup", 10, 20));
  const drop = animations.at(-1);
  assert.equal(drop?.element.classList.contains("dashboard-drag-ghost"), true);
  assert.equal(drop?.keyframes[1]?.["transform"], "translate3d(0px, 0px, 0)",
    "the drop destination must ignore the source card's animated bounding rect");
  const animationCount = animations.length;
  drop?.finish();
  assert.equal(document.querySelector(".dashboard-drag-ghost"), null);
  assert.equal(animations.length, animationCount, "landing must not add a scale animation");
  firstHandle.dispatchEvent(pointerEvent("pointerdown", 50, 20));
  browser.dispatchEvent(pointerEvent("pointermove", 180, 20));
  browser.dispatchEvent(pointerEvent("pointerup", 180, 20));
  const interruptedDrop = animations.at(-1);
  assert.ok(document.querySelector(".dashboard-drag-ghost"));
  firstHandle.dispatchEvent(pointerEvent("pointerdown", 150, 20));
  assert.equal(document.querySelector(".dashboard-drag-ghost"), null,
    "a new drag must finish the previous landing and clear its timer");
  browser.dispatchEvent(pointerEvent("pointermove", 160, 20));
  flushFrame();
  interruptedDrop?.finish();
  assert.ok(document.querySelector(".dashboard-drag-ghost"), "old callbacks must not clear the new drag");
  escape();
  // Preserve the original non-animated path for the remaining edit/save checks.
  Reflect.deleteProperty(browser.HTMLElement.prototype, "animate");
  assert.deepEqual(order(), ["kpi-b", "kpi-a"]);

  editButton.click();
  await waitFor(
    () => edits.length === 1 && reloads >= 2 && editButton.getAttribute("aria-pressed") === "false",
    "failed completion was not rolled back",
  );
  assert.deepEqual(edits[0], {
    action: "reorder",
    baseRevision: 0,
    widgetIds: ["kpi-b", "kpi-a"],
  });
  assert.deepEqual(
    [...document.querySelectorAll("[data-widget-id]")].map((card) => (card as HTMLElement).dataset["widgetId"]),
    ["kpi-a", "kpi-b"],
    "a failed completion should restore the authoritative order",
  );

  editButton.click();
  const retry = new browser.Event("keydown", { bubbles: true, cancelable: true });
  Object.defineProperty(retry, "key", { value: "ArrowRight" });
  firstHandle.dispatchEvent(retry);
  assert.equal(edits.length, 1);
  editButton.click();
  await waitFor(
    () => dashboard.revision === 1 && editButton.getAttribute("aria-pressed") === "false",
    "completed keyboard reorder was not persisted",
  );
  assert.deepEqual(edits[1], {
    action: "reorder",
    baseRevision: 0,
    widgetIds: ["kpi-b", "kpi-a"],
  });

  editButton.click();

  const closeA = document.querySelector("[data-close-widget-id='kpi-a']") as HTMLButtonElement;
  closeA.click();
  assert.equal(document.querySelector("[data-widget-id='kpi-a']")?.hasAttribute("hidden"), true);
  const undo = document.querySelector("#toast button") as HTMLButtonElement;
  undo.click();
  assert.equal(document.querySelector("[data-widget-id='kpi-a']")?.hasAttribute("hidden"), false);
  assert.equal(edits.length, 2, "undo must not call the server");

  closeA.click();
  assert.equal(edits.length, 2, "closing must remain local until the user clicks complete");
  editButton.click();
  await waitFor(
    () => dashboard.widgets.length === 1 && editButton.getAttribute("aria-pressed") === "false",
    "finishing edit mode did not commit removal",
  );
  assert.deepEqual(edits[2], {
    action: "remove",
    baseRevision: 1,
    widgetId: "kpi-a",
  });
  editButton.click();
  const closeB = document.querySelector("[data-close-widget-id='kpi-b']") as HTMLButtonElement;
  closeB.click();
  editButton.click();
  await waitFor(
    () => dashboard.widgets.length === 0 && Boolean(document.querySelector(".dashboard-empty")),
    "last widget was not removed",
  );
  assert.match(document.querySelector(".dashboard-empty")?.textContent ?? "", /当前看板为空/u);

  const input = document.querySelector("#questionInput") as HTMLTextAreaElement;
  const composer = document.querySelector("#composer") as HTMLFormElement;
  input.value = "重新生成看板";
  composer.dispatchEvent(new browser.Event("submit", { bubbles: true, cancelable: true }));
  await waitFor(() => Boolean(streamController), "agent stream did not start");
  assert.equal(editButton.disabled, true);
  streamController?.enqueue(encoder.encode(
    `event: done\ndata: ${JSON.stringify(sessionWithDashboard(dashboard))}\n\n`,
  ));
  streamController?.close();
  await waitFor(() => !editButton.disabled, "edit button did not unlock after the answer");

  // Reload real cards, then switch sessions while a pointer frame is pending.
  dashboard = { ...dashboard, widgets: [kpi("kpi-a", "指标 A", 1), kpi("kpi-b", "指标 B", 2)] };
  const selectSession = (id: string): void => {
    const button = document.createElement("button");
    button.dataset["sessionId"] = id;
    document.querySelector("#sessionList")?.append(button);
    button.click();
  };
  selectSession("session-edit");
  await waitFor(() => Boolean(document.querySelector("[data-drag-handle='kpi-a']")), "cards did not reload");
  editButton.click();
  const reloadedHandle = document.querySelector("[data-drag-handle='kpi-a']") as HTMLButtonElement;
  reloadedHandle.dispatchEvent(pointerEvent("pointerdown", 10, 20));
  browser.dispatchEvent(pointerEvent("pointermove", 180, 20));
  assert.equal(frames.size, 1);
  const editCount = edits.length;
  selectSession("session-other");
  await waitFor(() => Boolean(document.querySelector(".dashboard-empty")), "session did not switch");
  flushFrame();
  assert.equal(document.querySelector(".dashboard-drag-ghost"), null);
  assert.equal(document.querySelector(".dragging-source"), null);
  assert.equal(capturedPointer, null);
  assert.equal(edits.length, editCount, "switching must cancel the uncommitted pointer move");
});
