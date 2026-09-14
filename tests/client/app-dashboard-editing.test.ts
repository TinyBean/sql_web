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
  for (const card of grid.querySelectorAll<HTMLElement>("[data-widget-id]")) {
    Object.defineProperty(card, "getBoundingClientRect", {
      configurable: true,
      value(): DOMRect {
        const cards = [...grid.querySelectorAll<HTMLElement>("[data-widget-id]")];
        const left = cards.indexOf(card) * 100;
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
  browser.dispatchEvent(pointerEvent("pointermove", 10, 20));
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
  assert.deepEqual(
    [...document.querySelectorAll("[data-widget-id]")].map((card) => (card as HTMLElement).dataset["widgetId"]),
    ["kpi-b", "kpi-a"],
    "cards should continue sliding while the pointer moves",
  );
  const draggedCard = document.querySelector("[data-widget-id='kpi-a']");
  browser.dispatchEvent(pointerEvent("pointerup", 180, 20));
  assert.equal(edits.length, 0, "dropping must not persist or redraw the dashboard");
  assert.equal(document.querySelector("[data-widget-id='kpi-a']"), draggedCard);
  assert.deepEqual(
    [...document.querySelectorAll("[data-widget-id]")].map((card) => (card as HTMLElement).dataset["widgetId"]),
    ["kpi-b", "kpi-a"],
    "cards should remain at the local dropped position",
  );

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
});
