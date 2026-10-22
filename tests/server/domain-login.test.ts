import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { Authentication, AuthError, normalizeAccount, parseDomainResult, verifyDomainAccount } from "../../src/server/auth.ts";
import { createWebServer, type WebSessionPort } from "../../src/server/http-server.ts";
import { createDefaultDashboard } from "../../src/server/dashboard/default/template.ts";
import { createDashboardRegistry } from "../../src/server/dashboard/index.ts";
import { loadUserDashboards } from "../../src/server/dashboard/user-dashboards.ts";
import { writeDefaultDashboard } from "../../src/server/dashboard/default/index.ts";
import { AgentSessionStore } from "../../src/server/agent/agent-sessions.ts";
import { OWNER_ENTRY, readSessionFile } from "../../src/server/agent/session-files.ts";
import { ArtifactStore } from "../../src/server/tool/artifact-store.ts";
import { SessionDashboardStore } from "../../src/server/agent/session-dashboard.ts";
import { AppDatabase } from "../../src/server/database/database.ts";
import { CodeInterpreterRuntime } from "../../src/server/tool/code-interpreter.ts";
import { initializeOeeDatabase } from "../../scripts/database/initialize.ts";

async function listen(t: TestContext, server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return `http://127.0.0.1:${address.port}`;
}

const status = (expected: number) => (error: unknown) => error instanceof AuthError && error.statusCode === expected;

test("ASMX form POST preserves passwords, parses boolean XML and rejects service failures", async (t) => {
  const received: Array<{ path: string; body: string; method: string | undefined; contentType: string | undefined }> = [];
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    received.push({ path: request.url!, body: Buffer.concat(chunks).toString(), method: request.method, contentType: request.headers["content-type"] });
    if (request.url === "/slow") { setTimeout(() => response.end("late"), 60); return; }
    if (request.url === "/redirect") { response.writeHead(302, { Location: "/true" }); response.end(); return; }
    if (request.url === "/error") { response.writeHead(500); response.end("service failed"); return; }
    response.setHeader("Content-Type", "text/xml; charset=utf-8");
    response.end(request.url === "/invalid" ? "<boolean>true</boolean>" :
      `<?xml version="1.0" encoding="utf-8"?><boolean xmlns="http://tempuri.org/">${request.url === "/false" ? "false" : "true"}</boolean>`);
  });
  const base = await listen(t, server);
  const password = " p&x+=中文 ";
  assert.equal(await verifyDomainAccount("3000100562", password, { url: base + "/true" }), true);
  const form = new URLSearchParams(received[0]!.body);
  assert.equal(form.get("dUserName"), "3000100562");
  assert.equal(form.get("dPassword"), password);
  assert.equal(received[0]!.method, "POST");
  assert.equal(received[0]!.contentType, "application/x-www-form-urlencoded");
  assert.equal(await verifyDomainAccount("user", "wrong", { url: base + "/false" }), false);
  for (const endpoint of ["invalid", "error", "redirect", "slow"]) {
    await assert.rejects(verifyDomainAccount("user", password, { url: base + "/" + endpoint, timeoutMs: 20 }), status(503));
  }
  assert.equal(received.filter((item) => item.path === "/slow").length, 1);
  assert.equal(parseDomainResult('<x:boolean xmlns:x="http://tempuri.org/">1</x:boolean>'), true);
  assert.equal(parseDomainResult('<boolean xmlns="http://tempuri.org/">0</boolean>'), false);
  for (const xml of ['<boolean xmlns="evil">true</boolean>', '<!DOCTYPE x><boolean xmlns="http://tempuri.org/">true</boolean>',
    '<boolean xmlns="http://tempuri.org/">true</boolean><boolean>false</boolean>', '<boolean xmlns="http://tempuri.org/">yes</boolean>',
    '<?xml version="1.0\'?><boolean xmlns="http://tempuri.org/">true</boolean>',
    '<boolean xmlns="http://tempuri.org/">TRUE</boolean>']) {
    assert.throws(() => parseDomainResult(xml), status(503));
  }
});

test("login routes enforce cookies, expiry, logout, origin checks and account routing; completion stays anonymous", async (t) => {
  let now = Date.now();
  let verificationCount = 0;
  const authentication = new Authentication({ now: () => now, verify: async (_account, password) => {
    verificationCount++; return password === "correct";
  } });
  const initial = createDefaultDashboard();
  const sessions: WebSessionPort = {
    forAccount(account) { return { ...this, list: async () => [{ id: "session-12345", title: account,
      ownerAccount: account, readOnly: false, dashboardIds: ["default"], createdAt: "now", updatedAt: "now", messageCount: 1, active: false }],
      fork: async () => this.create() }; },
    status: () => ({ tools: [], model: { provider: "test", model: "test" }, codeInterpreter: { available: false, reason: "test" }, availableModelCount: 1, activeSessionCount: 0 }),
    list: async () => [], create: async () => ({ id: "session-12345", title: "new", ownerAccount: "user", readOnly: false,
      dashboardIds: ["default"], model: null, tools: [], streaming: false, messages: [], dashboards: [{ id: "default", title: "OEE综合看板", state: initial }] }),
    get: async () => { throw new Error("unused"); }, getSerialized: async () => { throw new Error("unused"); }, delete: async () => {}, prompt: async () => {}, abort: async () => {}, complete: async () => "anonymous answer",
  };
  const base = await listen(t, createWebServer({ sessions, authentication, dashboardForAccount: (account) => account === "3000100562" ? ["analysis"] : ["default"],
    database: { filePath: "oee.sqlite", getSchema: () => [] }, publicDir: path.join(process.cwd(), "public"), vendorDir: "node_modules", logger: { error() {} } }));
  const post = (route: string, body: unknown, cookie = "", origin?: string) => fetch(base + route, {
    method: "POST", headers: { "Content-Type": "application/json", Cookie: cookie, ...(origin ? { Origin: origin } : {}) }, body: JSON.stringify(body),
  });
  for (const route of ["/api/auth/me", "/api/sessions", "/api/schema"]) assert.equal((await fetch(base + route)).status, 401);
  assert.equal((await fetch(base + "/api/health")).status, 200);
  assert.equal((await post("/api/auth/login", { account: "user", password: "correct" }, "", "http://evil.example")).status, 403);
  assert.equal(verificationCount, 0);
  assert.equal((await post("/api/auth/login", { account: "user", password: "wrong" })).status, 401);
  const login = await post("/api/auth/login", { account: " 3000100562 ", password: "correct" });
  assert.equal(login.status, 200);
  assert.deepEqual((await login.json()).dashboardIds, ["analysis"]);
  const setCookie = login.headers.get("set-cookie")!;
  assert.match(setCookie, /HttpOnly; SameSite=Lax; Path=\/; Max-Age=28800/u);
  assert.ok(!setCookie.includes("Secure"));
  const cookie = setCookie.split(";")[0]!;
  const get = (route: string, token = cookie) => fetch(base + route, { headers: { Cookie: token } });
  const me = await (await get("/api/auth/me")).json();
  assert.equal(me.account, "3000100562");
  assert.equal((await (await get("/api/sessions")).json()).sessions[0].title, "3000100562");
  assert.equal((await post("/api/sessions", {}, cookie, "http://evil.example")).status, 403);
  assert.equal((await post("/api/sessions", {}, cookie, base.replace("http:", "https:"))).status, 403);
  const anonymous = await post("/chat/compeletion", { text: "question" });
  assert.equal(anonymous.status, 200);
  assert.equal((await anonymous.json()).text, "anonymous answer");
  const second = await post("/api/auth/login", { account: "bob", password: "correct" });
  const bobCookie = second.headers.get("set-cookie")!.split(";")[0]!;
  assert.equal((await post("/api/auth/logout", {}, cookie)).status, 200);
  assert.equal((await get("/api/auth/me")).status, 401);
  assert.equal((await get("/api/auth/me", bobCookie)).status, 200);
  now += 8 * 60 * 60 * 1000;
  assert.equal((await get("/api/auth/me", bobCookie)).status, 401);
  assert.equal(normalizeAccount(" Alice_1 "), "alice_1");
  for (const account of ["../user", "DOMAIN\\user", "user@domain", "a__b"]) assert.throws(() => normalizeAccount(account));
});

test("login rate limits expire, Secure is configurable and login state is never restored after restart", async () => {
  let now = 0;
  const failed = new Authentication({ now: () => now, verify: async () => false });
  for (let attempt = 0; attempt < 10; attempt++) await assert.rejects(failed.login({ account: "alice", password: "wrong" }, "ip"), status(401));
  await assert.rejects(failed.login({ account: "alice", password: "wrong" }, "ip2"), status(429));
  now = 300000;
  await assert.rejects(failed.login({ account: "alice", password: "wrong" }, "ip"), status(401));
  const auth = new Authentication({ secureCookie: true, verify: async () => true });
  const login = await auth.login({ account: "alice", password: "correct" }, "ip");
  assert.match(login.cookie, /; Secure$/u);
  const request = { headers: { cookie: login.cookie.split(";")[0] } } as never;
  assert.equal(auth.require(request).account, "alice");
  assert.throws(() => new Authentication().require(request), status(401));
});

async function sessionFixture(t: TestContext) {
  const root = mkdtempSync(path.join(tmpdir(), "domain-sessions-"));
  const data = path.join(root, ".data");
  const agentDir = path.join(data, "agent");
  mkdirSync(agentDir, { recursive: true });
  writeFileSync(path.join(agentDir, "models.json"), JSON.stringify({ providers: { test: { baseUrl: "http://127.0.0.1:1/v1", api: "openai-completions",
    apiKey: "test", models: [{ id: "test", name: "Test" }] } } }));
  const databasePath = path.join(data, "oee.sqlite");
  initializeOeeDatabase(databasePath);
  const database = AppDatabase.open({ filePath: databasePath });
  const artifacts = new ArtifactStore(path.join(data, "artifacts"));
  const defaultDashboardPath = path.join(data, "default-dashboard.json");
  writeDefaultDashboard(defaultDashboardPath, createDefaultDashboard(new Date("2026-10-01T00:00:00Z")));
  const registry = createDashboardRegistry({ defaultDashboardPath });
  const configFile = path.join(root, "users.json");
  writeFileSync(configFile, JSON.stringify({ defaultDashboard: "default", users: { "3000100562": "analysis" } }));

  const stores: AgentSessionStore[] = [];
  const open = async () => {
    const codeInterpreter = await CodeInterpreterRuntime.create({ projectRoot: root, pythonPath: path.join(root, "missing"), bwrapPath: path.join(root, "missing"), prlimitPath: path.join(root, "missing") });
    const store = await AgentSessionStore.open({ cwd: root, database, artifacts, agentDir, sessionDir: path.join(data, "sessions"),
      model: { provider: "test", model: "test" }, codeInterpreter, dashboardForAccount: loadUserDashboards(configFile, registry),
      dashboardTitle: (id) => registry.title(id), sharedDashboardPath: defaultDashboardPath,
      loadAccountDashboard: (id) => registry.loadInitial(id), loadInitialDashboard: () => registry.loadInitial() });
    stores.push(store);
    return store;
  };
  const store = await open();
  t.after(async () => { for (const item of stores) await item.dispose(); database.close(); rmSync(root, { recursive: true, force: true }); });
  return { root, data, store, artifacts, registry, configFile, defaultDashboardPath, open,
    dashboards: new SessionDashboardStore(artifacts, () => registry.loadInitial(), (id) => {
      const directory = path.join(data, "sessions");
      const filename = readdirSync(directory).find((name) => name.endsWith(id + ".jsonl"));
      const owner = filename ? readSessionFile(path.join(directory, filename)).owner : null;
      return owner?.dashboardIds.map((dashboardId) => ({ id: dashboardId, title: registry.title(dashboardId) }));
    }) };
}

test("owned empty sessions persist watermarks, isolate cached access and freeze account-selected dashboards across restarts", async (t) => {
  const env = await sessionFixture(t);
  const alice = env.store.forAccount("3000100562");
  const bob = env.store.forAccount("bob");
  const [a, b] = await Promise.all([alice.create(), bob.create()]);
  assert.equal(a.dashboards[0]!.state.widgets.length, 4);
  assert.deepEqual(a.dashboardIds, ["analysis"]);
  assert.equal(a.dashboards[0]!.title, "OEE分析看板");
  assert.equal(b.dashboards[0]!.title, "OEE综合看板");
  assert.deepEqual(a.dashboards[0]!.state.widgets.map((item) => item.id), env.registry.loadInitial("analysis").widgets.map((item) => item.id));
  assert.equal(b.dashboards[0]!.state.widgets.length, 13);
  assert.deepEqual((await alice.list()).map((item) => item.id), [a.id]);
  assert.deepEqual((await bob.list()).map((item) => item.id), [b.id]);
  const privateFile = readdirSync(path.join(env.data, "sessions")).find((name) => name.endsWith(a.id + ".jsonl"))!;
  assert.match(privateFile, /^3000100562__/u);
  assert.equal(readSessionFile(path.join(env.data, "sessions", privateFile)).owner?.account, "3000100562");
  const notFound = (error: unknown) => error instanceof Error && error.name === "SessionNotFoundError";
  for (const attempt of [() => bob.get(a.id), () => bob.getSerialized(a.id), () => bob.prompt(a.id, "question"), () => bob.abort(a.id),
    () => bob.delete(a.id), () => bob.fork(a.id)]) {
    await assert.rejects(attempt, notFound);
  }
  const updated = { ...env.registry.loadInitial(), dataAsOf: "2026-10-02T00:00:00.000Z" };
  writeDefaultDashboard(env.defaultDashboardPath, updated);
  assert.equal((await alice.create()).dashboards[0]!.state.dataAsOf, updated.dataAsOf);
  assert.equal((await alice.getSerialized(a.id)).dashboards[0]!.state.dataAsOf, a.dashboards[0]!.state.dataAsOf);
  await env.store.dispose();
  const restarted = await env.open();
  assert.equal((await restarted.forAccount("3000100562").getSerialized(a.id)).dashboards[0]!.state.widgets.length, 4);
  assert.equal((await restarted.forAccount("bob").list()).length, 1);
  await restarted.forAccount("bob").delete(b.id);
  assert.equal((await restarted.forAccount("bob").list()).length, 0);
});

test("legacy history is read-only; private copies preserve snapshots, references and ownership without touching the source", async (t) => {
  const env = await sessionFixture(t);
  const legacy = await env.store.create();
  const runtime = await env.store.get(legacy.id);
  runtime.sessionManager.appendMessage({ role: "user", content: "legacy question", timestamp: Date.now() });
  runtime.sessionManager.appendMessage({ role: "assistant", content: [{ type: "text", text: "legacy answer" }], api: "openai-completions",
    provider: "test", model: "test", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop", timestamp: Date.now() });
  const snapshots = env.artifacts.forSession(legacy.id);
  snapshots.createDataSnapshot("values", (fd) => {
    writeSync(fd, JSON.stringify({ columns: ["value"], rows: [{ value: 42 }], rowCount: 1, truncated: false }));
    return { columns: ["value"], rowCount: 1 };
  });
  const dashboards = new SessionDashboardStore(env.artifacts, () => env.registry.loadInitial());
  dashboards.loadOrInitialize(legacy.id);
  dashboards.apply(legacy.id, { action: "remove", baseRevision: 0, widgetId: legacy.dashboards[0]!.state.widgets[5]!.id });
  const sourceFile = runtime.sessionFile!;
  const sourceText = readFileSync(sourceFile, "utf8");
  const sourceDashboard = readFileSync(path.join(env.artifacts.rootDir, legacy.id, "dashboard.json"), "utf8");
  const alice = env.store.forAccount("3000100562");
  const bob = env.store.forAccount("bob");
  assert.equal((await alice.getSerialized(legacy.id)).readOnly, true);
  assert.equal((await bob.list())[0]!.ownerAccount, null);
  for (const attempt of [() => alice.get(legacy.id), () => alice.prompt(legacy.id, "write"), () => alice.abort(legacy.id),
    () => alice.delete(legacy.id)]) {
    await assert.rejects(attempt, status(403));
  }
  const copy = await alice.fork(legacy.id);
  assert.equal(copy.ownerAccount, "3000100562");
  assert.equal(copy.readOnly, false);
  assert.equal(copy.dashboards[0]!.state.widgets.length, 12, "legacy copy retains its source dashboard, despite the four-card account binding");
  assert.deepEqual(copy.messages.map((item) => item.text), ["legacy question", "legacy answer"]);
  assert.equal(env.artifacts.forSession(copy.id).resolveDataSnapshot("values").rowCount, 1);
  const copiedDashboard = JSON.parse(readFileSync(path.join(env.artifacts.rootDir, copy.id, "dashboard.json"), "utf8"));
  assert.deepEqual(copiedDashboard, JSON.parse(sourceDashboard));
  assert.equal(dashboards.apply(copy.id, { action: "reset", baseRevision: 1 }).dashboard.widgets.length, 13);
  assert.equal(readFileSync(sourceFile, "utf8"), sourceText);
  assert.equal(readFileSync(path.join(env.artifacts.rootDir, legacy.id, "dashboard.json"), "utf8"), sourceDashboard);
  assert.ok(!(await bob.list()).some((item) => item.id === copy.id));
  const copyFile = readdirSync(path.join(env.data, "sessions")).find((name) => name.endsWith(copy.id + ".jsonl"))!;
  const filePath = path.join(env.data, "sessions", copyFile);
  writeFileSync(filePath, readFileSync(filePath, "utf8").split("\n").filter((line) => !line.includes(OWNER_ENTRY)).join("\n"));
  assert.ok(!(await alice.list()).some((item) => item.id === copy.id), "a damaged private watermark must not become shared");
  await assert.rejects(alice.getSerialized(copy.id), { name: "SessionNotFoundError" });
  symlinkSync(sourceFile, path.join(env.artifacts.rootDir, legacy.id, "escape.jsonl"));
  const before = readdirSync(path.join(env.data, "sessions")).sort();
  await assert.rejects(alice.fork(legacy.id), /符号链接/u);
  assert.deepEqual(readdirSync(path.join(env.data, "sessions")).sort(), before);
  assert.ok(existsSync(sourceFile));
});

test("user dashboard configuration rejects unknown boards and duplicate normalized accounts", async (t) => {
  const env = await sessionFixture(t);
  assert.deepEqual(loadUserDashboards(env.configFile, env.registry)("unmapped"), ["default"]);
  writeFileSync(env.configFile, JSON.stringify({ defaultDashboard: "missing", users: {} }));
  assert.throws(() => loadUserDashboards(env.configFile, env.registry), /未知看板/u);
  writeFileSync(env.configFile, JSON.stringify({ defaultDashboard: "default", users: { Alice: "analysis", alice: "default" } }));
  assert.throws(() => loadUserDashboards(env.configFile, env.registry), /重复账号/u);
});

test("new account bindings freeze all boards while older single-board sessions retain their original selection", async (t) => {
  const env = await sessionFixture(t);
  const old = await env.store.forAccount("3000100562").create();
  await env.store.dispose();
  writeFileSync(env.configFile, JSON.stringify({ defaultDashboards: ["default"], users: { "3000100562": ["analysis", "default"] } }));
  const restarted = await env.open();
  const alice = restarted.forAccount("3000100562");
  assert.deepEqual((await alice.getSerialized(old.id)).dashboardIds, ["analysis"]);
  const multi = await alice.create();
  assert.deepEqual(multi.dashboardIds, ["analysis", "default"]);
  assert.deepEqual(multi.dashboards.map((item) => item.state.widgets.length), [4, 13]);
  const widgetId = multi.dashboards[0]!.state.widgets[0]!.id;
  env.dashboards.apply(multi.id, { action: "remove", widgetId, baseRevision: 0 }, "analysis").dashboard;
  const result = await alice.getSerialized(multi.id);
  assert.deepEqual(result.dashboards.map((item) => item.state.revision), [1, 0]);
  assert.deepEqual(result.dashboards.map((item) => item.state.widgets.length), [3, 13]);
  assert.throws(() => env.dashboards.apply(old.id, { action: "remove", widgetId, baseRevision: 0 }, "default").dashboard, /不存在/u);
  await assert.rejects(restarted.forAccount("bob").getSerialized(multi.id), { name: "SessionNotFoundError" });
  await restarted.dispose();
  const again = await env.open();
  assert.deepEqual((await again.forAccount("3000100562").getSerialized(multi.id)).dashboards, result.dashboards);
});

test("legacy private owners and snapshots preserve their analysis binding on read and edit", async (t) => {
  const env = await sessionFixture(t);
  const original = await env.store.forAccount("3000100562").create();
  await env.store.dispose();
  const root = path.join(env.data, "sessions");
  const filename = path.join(root, readdirSync(root).find((name) => name.endsWith(original.id + ".jsonl"))!);
  const legacySession = readFileSync(filename, "utf8").trim().split("\n").map((line) => {
    const entry = JSON.parse(line);
    return entry.customType === OWNER_ENTRY ? { ...entry, customType: "datalens_owner_v1", data: { account: "3000100562", dashboardId: "analysis" } } : entry;
  }).map((entry) => JSON.stringify(entry)).join("\n") + "\n";
  writeFileSync(filename, legacySession);
  const dashboardFile = path.join(env.artifacts.rootDir, original.id, "dashboard.json");
  const baseline = original.dashboards[0]!.state;
  const legacyDashboard = JSON.stringify({ schemaVersion: 1, baseline,
    current: { ...baseline, revision: 3, widgets: [] } });
  writeFileSync(dashboardFile, legacyDashboard);
  writeFileSync(env.configFile, JSON.stringify({ defaultDashboards: ["default"], users: { "3000100562": ["default", "analysis"] } }));
  const restarted = await env.open();
  const alice = restarted.forAccount("3000100562");
  const restored = await alice.getSerialized(original.id);
  assert.deepEqual(restored.dashboardIds, ["analysis"]);
  assert.equal(restored.dashboards[0]!.title, "OEE分析看板");
  assert.equal(restored.dashboards[0]!.state.revision, 3);
  assert.equal(readFileSync(dashboardFile, "utf8"), legacyDashboard);
  assert.ok(readFileSync(filename, "utf8").startsWith(legacySession));
  assert.deepEqual(readSessionFile(filename).owner?.dashboardIds, ["analysis"]);
  const current = env.dashboards.apply(original.id, { action: "reorder", baseRevision: 3, widgetIds: [] }, "analysis").dashboard;
  assert.equal(current.revision, 4);
  const saved = JSON.parse(readFileSync(dashboardFile, "utf8"));
  assert.equal(saved.schemaVersion, 2);
  assert.equal(saved.dashboards[0].id, "analysis");
  const reset = env.dashboards.apply(original.id, { action: "reset", baseRevision: 4 }, "analysis").dashboard;
  assert.deepEqual(reset, { ...baseline, revision: 5 });
  assert.deepEqual((await alice.create()).dashboardIds, ["default", "analysis"]);
});

test("copies multi-board shared history with all current states and reset baselines without applying the account config", async (t) => {
  const env = await sessionFixture(t);
  await env.store.dispose();
  writeFileSync(env.configFile, JSON.stringify({ defaultDashboards: ["default"], users: { "3000100562": ["analysis", "default"] } }));
  const originalStore = await env.open();
  const alice = originalStore.forAccount("3000100562");
  const source = await alice.create();
  env.dashboards.apply(source.id, { action: "remove", baseRevision: 0, widgetId: source.dashboards[0]!.state.widgets[0]!.id }, "analysis").dashboard;
  await originalStore.dispose();
  const root = path.join(env.data, "sessions");
  const ownedFile = path.join(root, readdirSync(root).find((name) => name.endsWith(source.id + ".jsonl"))!);
  const sharedFile = path.join(root, "legacy-" + source.id + ".jsonl");
  writeFileSync(sharedFile, readFileSync(ownedFile, "utf8").split("\n").filter((line) => !line.includes(OWNER_ENTRY)).join("\n"));
  rmSync(ownedFile);
  const sourceDashboard = readFileSync(path.join(env.artifacts.rootDir, source.id, "dashboard.json"), "utf8");
  const store = await env.open();
  const bob = store.forAccount("bob");
  const shared = await bob.getSerialized(source.id);
  assert.equal(shared.readOnly, true);
  assert.deepEqual(shared.dashboardIds, ["analysis", "default"]);
  const copy = await bob.fork(source.id);
  assert.deepEqual(copy.dashboardIds, shared.dashboardIds);
  assert.deepEqual(copy.dashboards, shared.dashboards);
  const snapshots = new SessionDashboardStore(env.artifacts, () => { throw new Error("must preserve copied baselines"); });
  assert.equal(snapshots.apply(copy.id, { action: "reset", baseRevision: 1 }, "analysis").dashboard.widgets.length, 4);
  assert.equal(snapshots.loadOrPreview(copy.id, "default").revision, 0);
  assert.equal(readFileSync(path.join(env.artifacts.rootDir, source.id, "dashboard.json"), "utf8"), sourceDashboard);
});
