/// <reference lib="dom" />

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { parseHTML } from "linkedom";
import type { ChatMessage, SerializedSession, SessionSummary } from "../../src/shared/contracts.ts";
import type { DashboardState } from "../../src/shared/dashboard.ts";

const projectRoot = process.cwd();
const EMPTY_DASHBOARD: DashboardState = {
  schemaVersion: 1,
  revision: 0,
  dataAsOf: "2026-09-08T00:00:00.000Z",
  dateRange: { start: null, end: null },
  widgets: [],
};

function serializedSession(
  id: string,
  title: string,
  messages: readonly ChatMessage[] = [],
): SerializedSession {
  return { id, title, model: null, tools: [], streaming: false, dashboard: EMPTY_DASHBOARD, messages };
}

function sessionSummary(id: string, title: string): SessionSummary {
  return {
    id,
    title,
    createdAt: "2026-09-08T00:00:00.000Z",
    updatedAt: "2026-09-08T00:00:00.000Z",
    messageCount: 0,
    active: true,
  };
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
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

test("switches between independent live session answers without stealing the current view", async (t) => {
  const html = readFileSync(path.join(projectRoot, "public", "index.html"), "utf8");
  const browser = parseHTML(html);
  const { document } = browser;
  const locationState = { hash: "", pathname: "/", search: "" };
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
  expose("history", {
    replaceState(_state: unknown, _unused: string, url: string): void {
      locationState.hash = url.startsWith("#") ? url : "";
    },
  });
  for (const name of globalNames.slice(4)) expose(name, browser[name]);
  expose("HTMLFormElement", document.querySelector("#composer")?.constructor);
  expose("HTMLTextAreaElement", document.querySelector("#questionInput")?.constructor);

  const sessions = [sessionSummary("session-a", "会话 A"), sessionSummary("session-b", "会话 B")];
  const stored = new Map([
    ["session-a", serializedSession("session-a", "会话 A", [
      { id: "history-user-a", role: "user", text: "A 历史问题" },
      { id: "history-assistant-a", role: "assistant", text: "A 历史回答" },
    ])],
    ["session-b", serializedSession("session-b", "会话 B", [
      { id: "history-user-b", role: "user", text: "B 历史问题" },
      { id: "history-assistant-b", role: "assistant", text: "B 历史回答" },
    ])],
  ]);
  const controllers = new Map<string, ReadableStreamDefaultController<Uint8Array>>();
  const sessionLoads = new Map<string, number>();
  const aborts: string[] = [];
  let resolveAbortA: (() => void) | undefined;
  const encoder = new TextEncoder();
  const originalFetch = globalThis.fetch;

  expose("fetch", async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.pathname : input.url;
    const method = init.method ?? "GET";
    if (url === "/api/health") {
      return jsonResponse({
        ok: true,
        database: { engine: "SQLite", path: "/tmp/test.sqlite" },
        agent: {
          tools: [],
          codeInterpreter: { available: false, reason: "test" },
          model: { provider: "test", model: "test-model" },
          availableModelCount: 1,
          activeSessionCount: 2,
        },
      });
    }
    if (url === "/api/schema") return jsonResponse({ objects: [] });
    if (url === "/api/sessions" && method === "GET") return jsonResponse({ sessions });
    if (url === "/api/sessions" && method === "POST") {
      const created = serializedSession("session-c", "新会话");
      if (!stored.has(created.id)) {
        stored.set(created.id, created);
        sessions.unshift(sessionSummary(created.id, created.title));
      }
      return jsonResponse(created);
    }

    const sessionMatch = /^\/api\/sessions\/([^/]+)$/u.exec(url);
    if (sessionMatch && method === "GET") {
      const id = decodeURIComponent(sessionMatch[1] ?? "");
      sessionLoads.set(id, (sessionLoads.get(id) ?? 0) + 1);
      const session = stored.get(id);
      assert.ok(session);
      return jsonResponse(session);
    }

    const messageMatch = /^\/api\/sessions\/([^/]+)\/messages$/u.exec(url);
    if (messageMatch && method === "POST") {
      const id = decodeURIComponent(messageMatch[1] ?? "");
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controllers.set(id, controller);
        },
      });
      return new Response(stream, {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      });
    }

    const abortMatch = /^\/api\/sessions\/([^/]+)\/abort$/u.exec(url);
    if (abortMatch && method === "POST") {
      const id = decodeURIComponent(abortMatch[1] ?? "");
      aborts.push(id);
      if (id === "session-a") {
        await new Promise<void>((resolve) => {
          resolveAbortA = resolve;
        });
      }
      return jsonResponse({ ok: true });
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

  const sessionButton = (id: string): HTMLButtonElement => {
    const button = document.querySelector(`[data-session-id="${id}"]`);
    assert.ok(button instanceof browser.HTMLButtonElement);
    return button as unknown as HTMLButtonElement;
  };
  const deleteButton = (id: string): HTMLButtonElement => {
    const button = document.querySelector(`[data-delete-session-id="${id}"]`);
    assert.ok(button instanceof browser.HTMLButtonElement);
    return button as unknown as HTMLButtonElement;
  };
  const input = document.querySelector("#questionInput") as unknown as HTMLTextAreaElement;
  const composer = document.querySelector("#composer") as unknown as HTMLFormElement;
  const messages = document.querySelector("#messages") as unknown as HTMLElement;
  const sendButton = document.querySelector("#sendButton") as unknown as HTMLButtonElement;
  const newChatButton = document.querySelector("#newChatButton") as unknown as HTMLButtonElement;
  const chatDock = document.querySelector("#chatDock") as HTMLElement;
  const chatCollapseButton = document.querySelector("#chatCollapseButton") as HTMLButtonElement;
  const dashboardMain = document.querySelector("#dashboardMain") as HTMLElement;
  const dashboardUpdatedAt = document.querySelector("#dashboardUpdatedAt") as HTMLElement;
  Object.defineProperty(messages, "clientHeight", { configurable: true, value: 300 });
  Object.defineProperty(messages, "scrollHeight", { configurable: true, value: 900 });
  const submit = (): void => {
    composer.dispatchEvent(new browser.Event("submit", { bubbles: true, cancelable: true }));
  };
  const sendSse = (id: string, event: string, data: unknown): void => {
    const controller = controllers.get(id);
    assert.ok(controller, `missing ${id} stream controller`);
    controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
  };
  const complete = (id: string, session: SerializedSession): void => {
    sendSse(id, "done", session);
    controllers.get(id)?.close();
  };

  await import(pathToFileURL(path.join(projectRoot, "public", "generated", "client", "app.js")).href);
  await waitFor(
    () => document.querySelector('[data-session-id="session-a"]')?.classList.contains("active") === true,
    "session A did not load",
  );
  assert.equal(messages.scrollTop, 900, "a session without a saved position should open at the bottom");
  assert.equal(chatDock.classList.contains("open"), false, "chat should start collapsed");
  input.value = "保留的草稿";
  input.dispatchEvent(new browser.Event("focus"));
  assert.equal(chatDock.classList.contains("open"), true);
  chatCollapseButton.click();
  assert.equal(chatDock.classList.contains("open"), false);
  assert.equal(input.value, "保留的草稿");
  input.dispatchEvent(new browser.Event("focus"));
  dashboardMain.click();
  assert.equal(chatDock.classList.contains("open"), false, "dashboard blank area should collapse chat");
  input.value = "";

  messages.scrollTop = 125;
  sessionButton("session-b").click();
  await waitFor(() => sessionButton("session-b").classList.contains("active"), "session B did not load");
  assert.equal(messages.scrollTop, 900, "a newly opened session should start at the bottom");
  messages.scrollTop = 275;
  sessionButton("session-a").click();
  await waitFor(() => sessionButton("session-a").classList.contains("active"), "session A did not reload");
  assert.equal(messages.scrollTop, 125, "session A should restore its historical scroll position");
  sessionButton("session-b").click();
  await waitFor(() => sessionButton("session-b").classList.contains("active"), "session B did not reload");
  assert.equal(messages.scrollTop, 275, "session B should restore its historical scroll position");
  sessionButton("session-a").click();
  await waitFor(() => sessionButton("session-a").classList.contains("active"), "session A did not reload again");
  assert.equal(messages.scrollTop, 125);
  const sessionALoadsBeforeStreaming = sessionLoads.get("session-a");

  input.value = "问题 A";
  submit();
  await waitFor(() => controllers.has("session-a"), "session A stream did not start");
  assert.equal(input.disabled, true);
  assert.equal(newChatButton.disabled, false);
  assert.equal(deleteButton("session-a").disabled, true);
  assert.equal(deleteButton("session-b").disabled, false);
  sendSse("session-a", "turn_start", { turn: 0 });
  sendSse("session-a", "text_delta", { turn: 0, delta: "A 正在回答" });
  sendSse("session-a", "dashboard_update", {
    turn: 0,
    toolCallId: "dashboard-a-1",
    dashboard: { ...EMPTY_DASHBOARD, revision: 1, dataAsOf: "2026-09-08T01:00:00.000Z" },
  });
  await waitFor(() => messages.textContent.includes("A 正在回答"), "session A progress was not rendered");
  assert.match(dashboardUpdatedAt.textContent ?? "", /r1/u);
  chatCollapseButton.click();
  assert.equal(chatDock.classList.contains("open"), false, "running chat can be collapsed");
  assert.equal(chatDock.classList.contains("streaming"), true);

  messages.scrollTop = 180;
  newChatButton.click();
  await waitFor(
    () => document.querySelector('[data-session-id="session-c"]')?.classList.contains("active") === true,
    "new session did not load while session A was answering",
  );
  assert.equal(input.disabled, false);
  assert.equal(sessionButton("session-a").classList.contains("streaming"), true);

  sessionButton("session-b").click();
  await waitFor(() => sessionButton("session-b").classList.contains("active"), "session B did not load");
  assert.match(dashboardUpdatedAt.textContent ?? "", /r0/u);
  assert.equal(input.disabled, false);
  assert.equal(sendButton.getAttribute("aria-label"), "发送问题");
  assert.equal(sessionButton("session-a").classList.contains("streaming"), true);
  assert.equal(sessionLoads.get("session-a"), sessionALoadsBeforeStreaming);
  assert.equal(messages.scrollTop, 275, "session B should keep its earlier position before a new question");

  input.value = "问题 B";
  submit();
  await waitFor(() => controllers.has("session-b"), "session B stream did not start");
  assert.equal(input.disabled, true);
  assert.equal(sessionButton("session-a").classList.contains("streaming"), true);
  assert.equal(sessionButton("session-b").classList.contains("streaming"), true);
  sendSse("session-b", "turn_start", { turn: 0 });
  sendSse("session-b", "text_delta", { turn: 0, delta: "B 正在回答" });
  await waitFor(() => messages.textContent.includes("B 正在回答"), "session B progress was not rendered");

  messages.scrollTop = 240;
  sendSse("session-a", "text_delta", { turn: 0, delta: "，后台新增" });
  sendSse("session-a", "dashboard_update", {
    turn: 0,
    toolCallId: "dashboard-a-2",
    dashboard: { ...EMPTY_DASHBOARD, revision: 2, dataAsOf: "2026-09-08T02:00:00.000Z" },
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(messages.scrollTop, 240, "background growth must not move the selected session");
  assert.match(dashboardUpdatedAt.textContent ?? "", /r0/u, "background dashboard must not replace selected session");

  sessionButton("session-a").click();
  await waitFor(() => sessionButton("session-a").classList.contains("active"), "session A was not restored");
  assert.equal(messages.textContent.includes("A 正在回答"), true);
  assert.equal(messages.textContent.includes("B 正在回答"), false);
  assert.match(dashboardUpdatedAt.textContent ?? "", /r2/u);
  sendSse("session-a", "dashboard_update", {
    turn: 0,
    toolCallId: "dashboard-a-late",
    dashboard: { ...EMPTY_DASHBOARD, revision: 1, dataAsOf: "2026-09-08T01:30:00.000Z" },
  });
  assert.match(dashboardUpdatedAt.textContent ?? "", /r2/u, "late revision must be ignored");
  assert.equal(sessionLoads.get("session-a"), sessionALoadsBeforeStreaming, "live session A should reuse its preserved view");
  assert.equal(messages.scrollTop, 180, "a live session should restore the position saved before leaving");
  sendSse("session-a", "text_delta", { turn: 0, delta: "，回来后继续" });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(messages.scrollTop, 180, "new deltas must not steal a restored viewport away from the bottom");
  messages.scrollTop = 600;
  sendSse("session-a", "text_delta", { turn: 0, delta: "，底部继续" });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(messages.scrollTop, 900, "new deltas should still follow a viewport already at the bottom");
  submit();
  await waitFor(() => aborts.length === 1, "session A abort did not start");
  assert.deepEqual(aborts, ["session-a"]);
  assert.equal(sendButton.disabled, true);

  sessionButton("session-b").click();
  await waitFor(() => sessionButton("session-b").classList.contains("active"), "session B was not restored");
  assert.equal(sendButton.disabled, false, "session A abort must not disable session B controls");
  assert.equal(messages.scrollTop, 240, "session B should restore the position saved before switching away");
  resolveAbortA?.();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(sendButton.disabled, false);

  messages.scrollTop = 23;
  sendSse("session-a", "text_delta", { turn: 0, delta: "，后台继续" });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(messages.scrollTop, 23, "background stream must not scroll the selected session");

  const completedA = serializedSession("session-a", "会话 A", [
    { id: "user-a", role: "user", text: "问题 A" },
    { id: "assistant-a", role: "assistant", text: "A 已完成" },
  ]);
  stored.set("session-a", completedA);
  complete("session-a", completedA);
  await waitFor(
    () => !sessionButton("session-a").classList.contains("streaming"),
    "session A indicator did not settle",
  );
  assert.equal(sessionButton("session-b").classList.contains("active"), true);
  assert.equal(sessionButton("session-b").classList.contains("streaming"), true);
  assert.equal(input.disabled, true);
  assert.equal(messages.textContent.includes("B 正在回答"), true);
  assert.equal(messages.textContent.includes("A 已完成"), false);

  const completedB = serializedSession("session-b", "会话 B", [
    { id: "user-b", role: "user", text: "问题 B" },
    { id: "assistant-b", role: "assistant", text: "B 已完成" },
  ]);
  stored.set("session-b", completedB);
  complete("session-b", completedB);
  await waitFor(() => !input.disabled, "session B controls did not settle");
  assert.equal(sessionButton("session-b").classList.contains("active"), true);
  assert.equal(sessionButton("session-a").classList.contains("streaming"), false);
  assert.equal(sessionButton("session-b").classList.contains("streaming"), false);
  await new Promise<void>((resolve) => setImmediate(resolve));
});
