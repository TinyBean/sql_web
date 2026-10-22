/// <reference lib="dom" />
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { parseHTML } from "linkedom";
import type { SerializedSession, SessionSummary } from "../../src/shared/contracts.ts";
import type { DashboardState } from "../../src/shared/dashboard.ts";

const dashboard: DashboardState = { schemaVersion: 1, revision: 0, dataAsOf: "2026-10-19T00:00:00Z", dateRange: { start: null, end: null }, widgets: [] };
function session(id: string, ownerAccount: string | null, text = ""): SerializedSession {
  return { id, ownerAccount, readOnly: ownerAccount === null, dashboardIds: ["default"], title: text || id, model: null,
    tools: [], streaming: false, dashboards: [{ id: "default", title: "OEE综合看板", state: dashboard }], messages: text ? [{ id: "user-1", role: "user", text }, { id: "assistant-1", role: "assistant", text: text + " answer" }] : [] };
}
function summary(value: SerializedSession): SessionSummary {
  return { id: value.id, title: value.title, ownerAccount: value.ownerAccount, readOnly: value.readOnly, dashboardIds: value.dashboardIds,
    createdAt: "2026-10-19T00:00:00Z", updatedAt: "2026-10-19T00:00:00Z", messageCount: value.messages.length, active: false };
}
function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}
async function waitFor(condition: () => boolean, message: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (condition()) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  assert.fail(message);
}

test("login, shared-history copying, logout and account switches discard streams and late responses", async (t) => {
  const browser = parseHTML(readFileSync(path.join(process.cwd(), "public/index.html"), "utf8"));
  const { document } = browser;
  const names = ["document", "window", "location", "history", "Element", "HTMLElement", "HTMLButtonElement", "HTMLDivElement",
    "HTMLDetailsElement", "HTMLFormElement", "HTMLTextAreaElement", "SVGSVGElement", "fetch"] as const;
  const originals = new Map(names.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  const expose = (name: string, value: unknown) => Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  const location = { hash: "", pathname: "/", search: "" };
  expose("document", document); expose("window", browser); expose("location", location);
  expose("history", { replaceState(_state: unknown, _title: string, url: string) { location.hash = url.startsWith("#") ? url : ""; } });
  for (const name of names.slice(4, -1)) expose(name, browser[name]);
  expose("HTMLFormElement", document.querySelector("#composer")!.constructor);
  expose("HTMLTextAreaElement", document.querySelector("#questionInput")!.constructor);
  t.after(() => { for (const [name, descriptor] of originals) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor); else Reflect.deleteProperty(globalThis, name);
  } });

  let account: string | null = null;
  let count = 0;
  let forks = 0;
  let completeFork: (() => void) | undefined;
  let lateResponse: (() => void) | undefined;
  let streamCancelled = false;
  let streamingSessionId: string | undefined;
  const legacy = session("legacy-session", null, "shared history");
  const secret = session("alice-private", "alice", "alice secret");
  const stored = new Map([[legacy.id, legacy], [secret.id, secret]]);
  const auth = () => ({ account, dashboardIds: ["default"], expiresAt: new Date(Date.now() + 3600000).toISOString() });
  expose("fetch", async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.pathname : input.url;
    const method = init.method ?? "GET";
    if (url === "/api/auth/me") return account ? json(auth()) : json({ error: "login", requestId: "auth" }, 401);
    if (url === "/api/auth/login") {
      const body = JSON.parse(init.body as string);
      assert.equal(body.password, " p&correct ", "the UI must preserve password whitespace");
      account = body.account;
      return json(auth());
    }
    if (url === "/api/auth/logout") { account = null; return json({ ok: true }); }
    if (!account) return json({ error: "expired", requestId: "auth" }, 401);
    if (url === "/api/sessions" && method === "GET") {
      return json({ sessions: [...stored.values()].filter((value) => value.ownerAccount === null || value.ownerAccount === account).map(summary) });
    }
    if (url === "/api/sessions" && method === "POST") {
      const created = session(`new-session-${++count}`, account);
      stored.set(created.id, created); return json(created);
    }
    if (url === "/api/sessions/legacy-session/fork") {
      forks++;
      return new Promise<Response>((resolve) => { completeFork = () => {
        const copy = { ...legacy, id: `copy-session-${forks}`, ownerAccount: account, readOnly: false };
        stored.set(copy.id, copy); resolve(json(copy));
      }; });
    }
    if (url === "/api/sessions/alice-private") return new Promise<Response>((resolve) => { lateResponse = () => resolve(json(secret)); });
    const messageMatch = /^\/api\/sessions\/([^/]+)\/messages$/u.exec(url);
    if (messageMatch) {
      streamingSessionId = messageMatch[1];
      return new Response(new ReadableStream<Uint8Array>({
        start(controller) { controller.enqueue(new TextEncoder().encode('event: turn_start\ndata: {"turn":0}\n\nevent: text_delta\ndata: {"turn":0,"delta":"alice live secret"}\n\n')); },
        cancel() { streamCancelled = true; },
      }), { headers: { "Content-Type": "text/event-stream" } });
    }
    const match = /^\/api\/sessions\/([^/]+)$/u.exec(url);
    if (match && method === "GET") return json(stored.get(match[1]!)!);
    throw new Error(`Unexpected request: ${method} ${url}`);
  });

  const compiled = import.meta.url.endsWith(".js");
  await import(pathToFileURL(path.join(process.cwd(), compiled ? "public/generated/client/app.js" : "src/client/app.ts")).href + "?domain-login");
  const loginButton = document.querySelector("#loginButton") as unknown as HTMLButtonElement;
  const loginForm = document.querySelector("#loginForm")!;
  const accountInput = document.querySelector("#loginAccount") as unknown as HTMLInputElement;
  const passwordInput = document.querySelector("#loginPassword") as unknown as HTMLInputElement;
  const messages = document.querySelector("#messages")!;
  const login = async (value: string) => {
    accountInput.value = value; passwordInput.value = " p&correct ";
    loginForm.dispatchEvent(new browser.Event("submit", { bubbles: true, cancelable: true }));
    await waitFor(() => !document.body.classList.contains("signed-out") && location.hash.startsWith("#session=new-session"), "login did not initialize a private session");
    assert.equal(passwordInput.value, "");
  };
  const selectLegacy = async () => {
    (document.querySelector('[data-session-id="legacy-session"]') as unknown as HTMLButtonElement).click();
    await waitFor(() => location.hash.includes("legacy-session"), "legacy session did not load");
  };
  await waitFor(() => !loginButton.disabled, "initial authentication did not settle");
  assert.equal(document.body.classList.contains("signed-out"), true);
  await login("alice");
  assert.equal(document.querySelector('[data-delete-session-id="legacy-session"]'), null);
  await selectLegacy();
  const input = document.querySelector("#questionInput") as unknown as HTMLTextAreaElement;
  input.value = "continue legacy";
  document.querySelector("#composer")!.dispatchEvent(new browser.Event("submit", { bubbles: true, cancelable: true }));
  await waitFor(() => forks === 1, "continuing shared history did not create a private copy");
  completeFork!();
  await waitFor(() => messages.textContent.includes("alice live secret"), "private copy stream did not start");
  assert.equal(streamingSessionId, "copy-session-1");
  (document.querySelector('[data-session-id="alice-private"]') as unknown as HTMLButtonElement).click();
  await waitFor(() => !!lateResponse, "late session request did not start");
  (document.querySelector("#logoutButton") as unknown as HTMLButtonElement).click();
  await waitFor(() => document.body.classList.contains("signed-out"), "logout did not hide the workspace");
  assert.equal(streamCancelled, true);
  assert.equal(messages.textContent, "");
  assert.equal(document.querySelector('[data-session-id="alice-private"]'), null);
  await login("bob");
  lateResponse!();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(messages.textContent.includes("alice"), false);
  assert.equal(document.querySelector('[data-session-id="copy-session-1"]'), null);
  assert.match(document.querySelector("#currentAccount")!.textContent, /bob/u);
  account = null;
  (document.querySelector("#newChatButton") as unknown as HTMLButtonElement).click();
  await waitFor(() => document.body.classList.contains("signed-out"), "an expired login did not return to the login form");
  assert.equal(document.querySelector("#currentAccount")!.textContent, "");
});
