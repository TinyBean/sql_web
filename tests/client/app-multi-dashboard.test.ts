/// <reference lib="dom" />
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { parseHTML } from "linkedom";
import type { SerializedSession, SessionSummary } from "../../src/shared/contracts.ts";
import type { SessionDashboard } from "../../src/shared/dashboard.ts";

function board(id: string, value: number): SessionDashboard {
  return { id, title: id === "default" ? "完整看板" : "概览看板", state: {
    schemaVersion: 1, revision: 0, dataAsOf: "2026-10-01T00:00:00Z", dateRange: { start: "2026-10-01", end: "2026-10-01" },
    widgets: [{ id: "same-card", title: id + " metric", kind: "kpi", subtitle: "",
      data: [{ value }], size: "small", encoding: { value: "value", comparison: null },
      format: { unit: "", precision: 2 }, metricDefinition: "测试指标", warnings: [] }],
  } };
}
function summary(session: SerializedSession): SessionSummary {
  return { id: session.id, title: session.title, dashboardIds: session.dashboardIds, ownerAccount: "alice", readOnly: false,
    createdAt: "2026-10-01T00:00:00Z", updatedAt: "2026-10-01T00:00:00Z", active: false, messageCount: session.messages.length };
}
function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}
async function waitFor(predicate: () => boolean, message: string): Promise<void> {
  for (let i = 0; i < 150; i++) {
    if (predicate()) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  assert.fail(message);
}

test("tabs preserve independent viewport positions, isolate background updates, and freeze the submitted target", async (t) => {
  const browser = parseHTML(readFileSync(path.join(process.cwd(), "public/index.html"), "utf8"));
  const { document } = browser;
  browser.matchMedia = () => ({ matches: true }) as MediaQueryList;
  const viewport = { left: 0, top: 0 };
  const maxScrollTop = () => document.querySelector("[role='tab'][aria-selected='true']")?.getAttribute("data-dashboard-id") === "overview" ? 300 : 2000;
  Object.defineProperties(browser, {
    scrollX: { configurable: true, get: () => viewport.left },
    scrollY: { configurable: true, get: () => Math.min(viewport.top, maxScrollTop()) },
    scrollTo: { configurable: true, value: (options: ScrollToOptions) => {
      viewport.left = options.left ?? viewport.left;
      viewport.top = Math.min(options.top ?? viewport.top, maxScrollTop());
    } },
  });
  Object.defineProperty(browser.HTMLElement.prototype, "focus", {
    configurable: true, value(this: HTMLElement, options?: FocusOptions) {
      if (this.getAttribute("role") === "tab" && !options?.preventScroll) viewport.top = 0;
    },
  });
  const originals = new Map<string, PropertyDescriptor | undefined>();
  const expose = (name: string, value: unknown) => {
    originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  };
  expose("document", document); expose("window", browser);
  const location = { hash: "#session=session-multi", pathname: "/", search: "" };
  expose("location", location);
  expose("history", { replaceState(_state: unknown, _title: string, url: string) { location.hash = url; } });
  for (const name of ["Element", "HTMLElement", "HTMLButtonElement", "HTMLDivElement", "HTMLDetailsElement", "SVGSVGElement"] as const) expose(name, browser[name]);
  expose("HTMLFormElement", document.querySelector("#composer")!.constructor);
  expose("HTMLTextAreaElement", document.querySelector("#questionInput")!.constructor);
  let session: SerializedSession = { id: "session-multi", title: "多看板会话", ownerAccount: "alice", readOnly: false,
    dashboardIds: ["default", "overview"], dashboards: [board("default", 10), board("overview", 20)],
    model: null, tools: [], streaming: false, messages: [{ id: "ready", role: "assistant", text: "准备完成" }] };
  const single: SerializedSession = { ...session, id: "session-single", title: "单看板会话", dashboardIds: ["default"], dashboards: [board("default", 30)] };
  let posted: { dashboardId: string; message: string } | undefined;
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
  expose("fetch", async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = String(input);
    if (url === "/api/auth/me") return json({ account: "alice", dashboardIds: session.dashboardIds, expiresAt: new Date(Date.now() + 3600000).toISOString() });
    if (url === "/api/auth/logout") return json({ ok: true });
    if (url === "/api/sessions") return json({ sessions: [summary(session), summary(single)] });
    if (url === "/api/sessions/session-multi") return json(session);
    if (url === "/api/sessions/session-single") return json(single);
    if (url.endsWith("/messages")) {
      posted = JSON.parse(String(init.body));
      return new Response(new ReadableStream<Uint8Array>({ start(value) { controller = value; } }),
        { headers: { "Content-Type": "text/event-stream" } });
    }
    throw new Error("unexpected request " + url);
  });
  t.after(() => {
    for (const [name, original] of originals) {
      if (original) Object.defineProperty(globalThis, name, original);
      else Reflect.deleteProperty(globalThis, name);
    }
  });
  await import(pathToFileURL(path.join(process.cwd(), "public/generated/client/app.js")).href + "?multi-dashboard");
  const selected = () => document.querySelector("[role='tab'][aria-selected='true']")?.getAttribute("data-dashboard-id");
  const tab = (id: string) => document.querySelector(`[role='tab'][data-dashboard-id='${id}']`) as unknown as HTMLButtonElement;
  const grid = document.querySelector("#dashboardGrid")!;
  await waitFor(() => selected() === "default", "first board not selected");
  assert.equal(document.querySelector("#dashboardTabs")!.hasAttribute("hidden"), false);
  assert.match(grid.textContent, /default metric/u);
  assert.equal(document.querySelector("#dashboardEditButton"), null);
  assert.equal(grid.querySelector("[data-drag-handle], [data-close-widget-id]"), null);
  viewport.left = 60; viewport.top = 1400;
  const next = new browser.Event("keydown", { bubbles: true, cancelable: true });
  Object.defineProperty(next, "key", { value: "ArrowRight" }); tab("default").dispatchEvent(next);
  await waitFor(() => selected() === "overview", "keyboard navigation failed");
  assert.equal(tab("overview").getAttribute("tabindex"), "0");
  assert.deepEqual(viewport, { left: 0, top: 0 }, "a board's first visit starts at the top");
  viewport.left = 15; viewport.top = 220;
  tab("default").click();
  await waitFor(() => selected() === "default", "default board not restored");
  assert.deepEqual(viewport, { left: 60, top: 1400 }, "the long board must retain its position after visiting a short board");
  tab("overview").click();
  await waitFor(() => selected() === "overview", "overview board not restored");
  assert.deepEqual(viewport, { left: 15, top: 220 }, "each board must restore its own viewport");
  tab("default").click();
  await waitFor(() => selected() === "default", "default board not selected before submitting");
  const input = document.querySelector("#questionInput") as unknown as HTMLTextAreaElement;
  input.value = "更新当前看板";
  document.querySelector("#composer")!.dispatchEvent(new browser.Event("submit", { bubbles: true, cancelable: true }));
  await waitFor(() => !!controller, "chat stream not opened");
  tab("overview").click();
  await waitFor(() => selected() === "overview", "could not switch during chat");
  assert.equal(posted?.dashboardId, "default");
  const send = (event: string, data: unknown) => controller!.enqueue(new TextEncoder().encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
  send("turn_start", { turn: 0 });
  const overview = { ...board("overview", 88).state, revision: 2 };
  send("dashboard_update", { turn: 0, toolCallId: "overview-write", dashboardId: "overview", dashboard: overview });
  await waitFor(() => grid.textContent.includes("overview metric"), "visible board update not applied");
  send("tool_call", { turn: 0, id: "default-write", name: "update_dashboard",
    arguments: { dashboard_id: "default", action: "upsert", widget: { id: "same-card" } } });
  send("status", { message: "pending-marker" });
  await waitFor(() => document.querySelector("#toast")!.textContent.includes("pending-marker"), "pending tool not received");
  assert.equal(grid.querySelector("[data-widget-id='same-card']")!.getAttribute("aria-busy"), "false");
  tab("default").click(); await waitFor(() => selected() === "default", "pending board not selected");
  assert.equal(grid.querySelector("[data-widget-id='same-card']")!.getAttribute("aria-busy"), "true");
  tab("overview").click(); await waitFor(() => selected() === "overview", "could not return to overview");
  const newer = { ...board("default", 99).state, revision: 3 };
  send("dashboard_update", { turn: 0, toolCallId: "default-write", dashboardId: "default", dashboard: newer });
  send("status", { message: "background-saved" });
  await waitFor(() => document.querySelector("#toast")!.textContent.includes("background-saved"), "background update not received");
  assert.equal(selected(), "overview", "background update changed the selected tab");
  send("dashboard_update", { turn: 0, toolCallId: "old-default", dashboardId: "default", dashboard: { ...newer, revision: 2 } });
  session = { ...session, dashboards: session.dashboards.map((item) => ({ ...item, state: item.id === "default" ? newer : overview })) };
  send("done", session); controller!.close();
  await waitFor(() => !input.readOnly, "chat did not finish");
  tab("default").click();
  await waitFor(() => selected() === "default", "default board not restored");
  assert.match(document.querySelector("#dashboardUpdatedAt")!.textContent, /r3/u, "stale event overwrote a newer revision");
  tab("overview").click(); await waitFor(() => selected() === "overview", "overview not selected");
  (document.querySelector("[data-session-id='session-single']") as unknown as HTMLButtonElement).click();
  await waitFor(() => location.hash.includes("session-single"), "single session not loaded");
  assert.equal(document.querySelector("#dashboardTabs")!.hasAttribute("hidden"), true);
  assert.deepEqual(viewport, { left: 0, top: 0 }, "another session with the same board ID must have a separate viewport");
  viewport.left = 5; viewport.top = 75;
  (document.querySelector("[data-session-id='session-multi']") as unknown as HTMLButtonElement).click();
  await waitFor(() => selected() === "overview", "session selection was not remembered");
  assert.deepEqual(viewport, { left: 15, top: 220 }, "returning to a session must restore its selected board position");
  (document.querySelector("[data-session-id='session-single']") as unknown as HTMLButtonElement).click();
  await waitFor(() => location.hash.includes("session-single"), "single session not revisited");
  assert.deepEqual(viewport, { left: 5, top: 75 });
  (document.querySelector("#logoutButton") as unknown as HTMLButtonElement).click();
  await waitFor(() => document.body.classList.contains("signed-out"), "logout failed");
  assert.equal(document.querySelectorAll("[role='tab']").length, 0);
  assert.equal(grid.textContent.includes("metric"), false);
  assert.deepEqual(viewport, { left: 0, top: 0 }, "logout must reset the dashboard viewport");
});
