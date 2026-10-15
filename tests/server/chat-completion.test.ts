import assert from "node:assert/strict";
import { once } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { AgentSession } from "@earendil-works/pi-coding-agent";
import { initializeOeeDatabase } from "../../scripts/database/initialize.ts";
import { AgentSessionStore } from "../../src/server/agent/agent-sessions.ts";
import { API_CHAT_AGENT_RULES } from "../../src/server/agent/prompts.ts";
import { createDefaultDashboard } from "../../src/server/dashboard/default/template.ts";
import { AppDatabase } from "../../src/server/database/database.ts";
import { createWebServer } from "../../src/server/http-server.ts";
import { ArtifactStore } from "../../src/server/tool/artifact-store.ts";
import { CodeInterpreterRuntime } from "../../src/server/tool/code-interpreter.ts";

interface ModelRequest {
  readonly model: string;
  readonly messages: { role: string; content: string | { type: string; text?: string }[] }[];
  readonly tools: { function: { name: string } }[];
}

interface ModelReply {
  readonly text?: string;
  readonly calls?: readonly { name: string; args: unknown }[];
  readonly finishReason?: string;
  readonly error?: string;
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

function contentText(content: ModelRequest["messages"][number]["content"]): string {
  return typeof content === "string" ? content : content.map((part) => part.text ?? "").join("");
}

function userText(body: ModelRequest): string {
  return contentText(body.messages.findLast((message) => message.role === "user")?.content ?? "");
}

async function listen(server: Server): Promise<string> {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return `http://127.0.0.1:${address.port}`;
}

async function close(server: Server): Promise<void> {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

async function fixture(
  t: TestContext,
  respond: (body: ModelRequest, response: ServerResponse) => ModelReply | Promise<ModelReply> = () => ({ text: "完整回答" }),
) {
  const directory = mkdtempSync(path.join(tmpdir(), "sql-web-completion-"));
  const requests: ModelRequest[] = [];
  const modelErrors: unknown[] = [];
  const modelServer = createServer(async (request, response) => {
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body = JSON.parse(Buffer.concat(chunks).toString()) as ModelRequest;
      requests.push(body);
      const result = await respond(body, response);
      if (response.destroyed) return;
      if (result.error) {
        response.writeHead(400, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: { message: result.error } }));
        return;
      }
      const calls = result.calls?.map((call, index) => ({
        index, id: `call-${index}`, type: "function",
        function: { name: call.name, arguments: JSON.stringify(call.args) },
      }));
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end("data: " + JSON.stringify({
        id: "completion", object: "chat.completion.chunk", choices: [{ index: 0,
          delta: { role: "assistant", content: result.text ?? "", ...(calls ? { tool_calls: calls } : {}) },
          finish_reason: null,
        }],
      }) + "\n\ndata: " + JSON.stringify({
        id: "completion", choices: [{ index: 0, delta: {},
          finish_reason: result.finishReason ?? (calls ? "tool_calls" : "stop"),
        }], usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
      }) + "\n\ndata: [DONE]\n\n");
    } catch (error) {
      modelErrors.push(error);
      if (!response.destroyed) { response.writeHead(500); response.end("mock model failed"); }
    }
  });
  const modelUrl = await listen(modelServer);
  const agentDir = path.join(directory, "agent");
  mkdirSync(agentDir);
  writeFileSync(path.join(agentDir, "models.json"), JSON.stringify({ providers: { test: {
    baseUrl: `${modelUrl}/v1`, api: "openai-completions", apiKey: "test-only",
    models: [{ id: "test-model", name: "Test", reasoning: false, contextWindow: 128000, maxTokens: 8192 }],
  } } }));
  writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify({ retry: { enabled: false } }));
  const databasePath = path.join(directory, "test.sqlite");
  initializeOeeDatabase(databasePath);
  const database = AppDatabase.open({ filePath: databasePath });
  const artifacts = new ArtifactStore(path.join(directory, "artifacts"));
  const interpreter = await CodeInterpreterRuntime.create({
    projectRoot: directory, pythonPath: "/nonexistent/python",
    bwrapPath: "/nonexistent/bwrap", prlimitPath: "/nonexistent/prlimit",
  });
  const events: { event: string; fields?: Readonly<Record<string, unknown>> }[] = [];
  const logger = {
    info(event: string, fields?: Readonly<Record<string, unknown>>) {
      events.push({ event, ...(fields ? { fields } : {}) });
    },
    warn(event: string, fields?: Readonly<Record<string, unknown>>) {
      events.push({ event, ...(fields ? { fields } : {}) });
    },
    error(event: string, _error: unknown, fields?: Readonly<Record<string, unknown>>) {
      events.push({ event, ...(fields ? { fields } : {}) });
    },
  };
  const store = await AgentSessionStore.open({
    database, artifacts, codeInterpreter: interpreter, cwd: directory,
    sessionDir: path.join(directory, "sessions"), agentDir,
    model: { provider: "test", model: "test-model" },
    email: { host: "127.0.0.1", port: 25, fromAddress: "test@example.com", fromName: "Test" },
    loadInitialDashboard: () => createDefaultDashboard(), logger,
  });
  const httpServer = createWebServer({
    database, sessions: store, publicDir: path.join(process.cwd(), "public"),
    vendorDir: path.join(process.cwd(), "node_modules"), logger,
  });
  const baseUrl = await listen(httpServer);
  t.after(async () => {
    await store.dispose();
    await close(httpServer);
    await close(modelServer);
    database.close();
    rmSync(directory, { recursive: true, force: true });
    assert.deepEqual(modelErrors, []);
  });
  const post = (text: string, signal?: AbortSignal) => fetch(`${baseUrl}/chat/compeletion`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text }), ...(signal ? { signal } : {}),
  });
  const assertEmpty = async () => {
    assert.deepEqual(await store.list(), []);
    assert.equal(store.status().activeSessionCount, 0);
    assert.deepEqual(readdirSync(path.join(directory, "sessions")), []);
    assert.deepEqual(readdirSync(artifacts.rootDir), []);
  };
  return { directory, artifacts, store, interpreter, httpServer, baseUrl, post, requests, events, assertEmpty };
}

test("completion returns final text after tools, shares website configuration and deletes temporary artifacts", { timeout: 15000 }, async (t) => {
  const env = await fixture(t, (body) => body.messages.some((message) => message.role === "tool")
    ? { text: "  最终回答\n保留正文格式  " }
    : { text: "先查询数据库。", calls: [{ name: "execute_sql", args: { sql: "SELECT 42 AS answer", save_as: "answer" } }] });
  const page = await env.store.create();
  await env.store.prompt(page.id, "网页问题");
  const pageRequest = env.requests[0]!;
  await env.store.delete(page.id);
  let artifactExisted = false;
  const deleteSession = env.artifacts.deleteSession.bind(env.artifacts);
  t.mock.method(env.artifacts, "deleteSession", async (id: string) => {
    artifactExisted = existsSync(path.join(env.artifacts.rootDir, id, "snapshots.json"));
    await deleteSession(id);
  });
  const response = await env.post("  临时问题  ");
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /application\/json/u);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  assert.ok(response.headers.get("x-request-id"));
  assert.deepEqual(await response.json(), { text: "最终回答\n保留正文格式" });
  const completionRequest = env.requests[2]!;
  assert.equal(userText(completionRequest), "临时问题");
  assert.equal(completionRequest.model, pageRequest.model);
  assert.deepEqual(completionRequest.tools, pageRequest.tools);
  const pageSystem = pageRequest.messages.filter((m) => m.role === "system").map((m) => contentText(m.content)).join("\n");
  const completionSystem = completionRequest.messages.filter((m) => m.role === "system").map((m) => contentText(m.content)).join("\n");
  assert.ok(completionSystem.includes(API_CHAT_AGENT_RULES));
  assert.equal(pageSystem.includes(API_CHAT_AGENT_RULES), false);
  assert.equal(completionSystem.replace(API_CHAT_AGENT_RULES, ""), pageSystem);
  assert.ok(completionRequest.tools.some((tool) => tool.function.name === "send_email"));
  assert.ok(completionRequest.tools.some((tool) => tool.function.name === "subagent"));
  assert.ok(completionRequest.messages.some((message) => /sql_web.dashboard.context/u.test(contentText(message.content))));
  assert.equal(artifactExisted, true);
  assert.ok(env.events.some(({ event, fields }) => event === "agent.prompt.started" && fields?.["requestId"] === response.headers.get("x-request-id")));
  assert.ok(env.events.some(({ event, fields }) => event === "http.request.completed" && fields?.["route"] === "/chat/compeletion" && fields["statusCode"] === 200));
  await env.assertEmpty();
});

test("completion validates JSON and text before creating an agent", { timeout: 15000 }, async (t) => {
  const env = await fixture(t);
  const cases: { body: string; status: number; contentType?: string }[] = [
    { body: "{", status: 400 },
    ...[{}, null, [], "question", { message: "question" }, { text: null }, { text: 1 }, { text: false },
      { text: "" }, { text: " \n\t " }, { text: "x".repeat(4001) }].map((value) => ({ body: JSON.stringify(value), status: 400 })),
    { body: '{"text":"question"}', status: 415, contentType: "text/plain" },
    { body: JSON.stringify({ text: "question", padding: "x".repeat(65536) }), status: 413 },
  ];
  for (const { body, status, contentType = "application/json" } of cases) {
    const response = await fetch(`${env.baseUrl}/chat/compeletion`, {
      method: "POST", headers: { "content-type": contentType }, body,
    });
    assert.equal(response.status, status);
    const error = await response.json() as { error: string; requestId: string };
    assert.ok(error.error);
    assert.equal(error.requestId, response.headers.get("x-request-id"));
  }
  await assert.rejects(env.store.complete(" "), /问题不能为空/u);
  await assert.rejects(env.store.complete("x".repeat(4001)), /4000/u);
  assert.equal(env.requests.length, 0);
  assert.equal((await fetch(`${env.baseUrl}/chat/compeletion`)).status, 404);
  const boundary = await env.post("x".repeat(4000));
  assert.equal(boundary.status, 200);
  await boundary.text();
  await env.assertEmpty();
});

test("concurrent completions keep isolated history, snapshots and dashboard changes", { timeout: 15000 }, async (t) => {
  const bothStarted = deferred();
  const release = deferred();
  let waiting = 0;
  const env = await fixture(t, async (body) => {
    const tools = body.messages.filter((message) => message.role === "tool");
    if (!tools.length) return { calls: [{ name: "execute_sql", args: { sql: "SELECT 1 AS answer", save_as: "same_name" } }] };
    if (tools.length === 1) return { calls: [{ name: "update_dashboard", args: { action: "reset", base_revision: 0 } }] };
    waiting += 1;
    if (waiting === 2) bothStarted.resolve();
    await release.promise;
    return { text: `回答:${userText(body)}` };
  });
  const first = env.post("问题一");
  const second = env.post("问题二");
  try {
    await bothStarted.promise;
    assert.deepEqual(await env.store.list(), []);
    assert.equal(env.store.status().activeSessionCount, 0);
    assert.deepEqual(readdirSync(path.join(env.directory, "sessions")), []);
    const ids = readdirSync(env.artifacts.rootDir);
    assert.equal(ids.length, 2);
    for (const id of ids) {
      assert.equal(existsSync(path.join(env.artifacts.rootDir, id, "snapshots.json")), true);
      assert.equal(existsSync(path.join(env.artifacts.rootDir, id, "dashboard.json")), true);
    }
    for (const body of env.requests) {
      const questions = body.messages.filter((m) => m.role === "user")
        .map((m) => contentText(m.content)).filter((text) => text === "问题一" || text === "问题二");
      assert.equal(questions.length, 1);
    }
  } finally {
    release.resolve();
  }
  assert.deepEqual(await (await first).json(), { text: "回答:问题一" });
  assert.deepEqual(await (await second).json(), { text: "回答:问题二" });
  await env.assertEmpty();
});

test("completion rejects failed, empty, truncated and aborted model answers and cleans snapshots", { timeout: 15000 }, async (t) => {
  const env = await fixture(t, (body) => {
    if (!body.messages.some((m) => m.role === "tool")) {
      return { calls: [{ name: "execute_sql", args: { sql: "SELECT 1 AS answer", save_as: "temporary" } }] };
    }
    switch (userText(body)) {
      case "failed": return { error: "model failure" };
      case "empty": return { text: " \n " };
      case "truncated": return { text: "未完成的回答", finishReason: "length" };
      default: return { text: "未完成的回答", finishReason: "content_filter" };
    }
  });
  for (const text of ["failed", "empty", "truncated", "aborted"]) {
    const response = await env.post(text);
    assert.equal(response.status, 500, text);
    const error = await response.json() as { error: string; requestId: string };
    assert.ok(error.error);
    assert.equal(error.requestId, response.headers.get("x-request-id"));
    assert.equal("text" in error, false);
    await env.assertEmpty();
  }
});

test("completion disposes a partially initialized session when extension binding fails", { timeout: 15000 }, async (t) => {
  const env = await fixture(t);
  const dispose = AgentSession.prototype.dispose;
  let disposed = 0;
  t.mock.method(AgentSession.prototype, "dispose", function (this: AgentSession) {
    disposed += 1;
    dispose.call(this);
  });
  t.mock.method(AgentSession.prototype, "bindExtensions", async function (this: AgentSession) {
    assert.equal(this.sessionFile, undefined);
    const output = path.join(env.artifacts.rootDir, this.sessionId);
    mkdirSync(output);
    writeFileSync(path.join(output, "partial.json"), "{}");
    throw new Error("extension initialization failed");
  });
  const response = await env.post("question");
  assert.equal(response.status, 500);
  assert.match((await response.json() as { error: string }).error, /extension initialization failed/u);
  assert.equal(disposed, 1);
  assert.equal(env.requests.length, 0);
  await env.assertEmpty();
});

test("client disconnect cancels the model request and waits for artifact cleanup", { timeout: 15000 }, async (t) => {
  const started = deferred();
  const cleaned = deferred();
  const env = await fixture(t, async (body, response) => {
    if (!body.messages.some((m) => m.role === "tool")) {
      return { calls: [{ name: "execute_sql", args: { sql: "SELECT 1 AS answer", save_as: "temporary" } }] };
    }
    started.resolve();
    await once(response, "close");
    return { text: "不能返回此回答" };
  });
  const deleteSession = env.artifacts.deleteSession.bind(env.artifacts);
  t.mock.method(env.artifacts, "deleteSession", async (id: string) => {
    await deleteSession(id);
    cleaned.resolve();
  });
  const controller = new AbortController();
  const request = env.post("question", controller.signal);
  const rejected = assert.rejects(request, { name: "AbortError" });
  await started.promise;
  controller.abort();
  await rejected;
  await cleaned.promise;
  await env.assertEmpty();
  assert.equal(env.events.some(({ event, fields }) => event === "http.request.completed" && fields?.["aborted"] === true), true);
});

test("store shutdown cancels completions and waits for cleanup before disposing shared resources", { timeout: 15000 }, async (t) => {
  const started = deferred();
  const env = await fixture(t, async (_body, response) => {
    started.resolve();
    await once(response, "close");
    return { text: "不能返回此回答" };
  });
  const cleaned = deferred();
  const allowCleanup = deferred();
  const deleteSession = env.artifacts.deleteSession.bind(env.artifacts);
  t.mock.method(env.artifacts, "deleteSession", async (id: string) => {
    cleaned.resolve();
    await allowCleanup.promise;
    await deleteSession(id);
  });
  const dispose = t.mock.method(env.interpreter, "dispose");
  const pending = env.store.complete("question");
  const rejected = assert.rejects(pending, /正在关闭/u);
  await started.promise;
  const stopping = env.store.dispose();
  try {
    await cleaned.promise;
    assert.equal(dispose.mock.callCount(), 0);
    await assert.rejects(env.store.complete("another question"), /正在关闭/u);
  } finally {
    allowCleanup.resolve();
  }
  await stopping;
  await rejected;
  assert.equal(dispose.mock.callCount(), 1);
  await env.assertEmpty();
});

test("completion cancellation propagates to delegated agents and removes their snapshots", { timeout: 15000 }, async (t) => {
  const childStarted = deferred();
  const env = await fixture(t, async (body, response) => {
    if (userText(body) === "delegate") {
      return { calls: [{ name: "subagent", args: { tasks: [{ name: "child", task: "investigate" }] } }] };
    }
    if (!body.messages.some((message) => message.role === "tool")) {
      return { calls: [{ name: "execute_sql", args: { sql: "SELECT 1 AS answer", save_as: "child_snapshot" } }] };
    }
    childStarted.resolve();
    await once(response, "close");
    return { text: "不能返回此回答" };
  });
  const controller = new AbortController();
  const pending = env.store.complete("delegate", { signal: controller.signal });
  const rejected = assert.rejects(pending, /stop completion/u);
  await childStarted.promise;
  const ids = readdirSync(env.artifacts.rootDir);
  assert.equal(ids.length, 1);
  assert.ok(readdirSync(path.join(env.artifacts.rootDir, ids[0]!)).length > 0);
  controller.abort(new Error("stop completion"));
  await rejected;
  await env.assertEmpty();
  assert.ok(env.events.some(({ event }) => event === "agent.subagent.event"));
});

test("cancellation during initialization or prompt preflight prevents a model request", { timeout: 15000 }, async (t) => {
  const env = await fixture(t);
  const alreadyAborted = AbortSignal.abort(new Error("already cancelled"));
  await assert.rejects(env.store.complete("question", { signal: alreadyAborted }), /already cancelled/u);
  for (const method of ["bindExtensions", "prompt"] as const) {
    const entered = deferred();
    const release = deferred();
    const controller = new AbortController();
    const original = AgentSession.prototype[method];
    const mocked = t.mock.method(AgentSession.prototype, method, async function (
      this: AgentSession, ...args: unknown[]
    ) {
      entered.resolve();
      await release.promise;
      return Reflect.apply(original, this, args);
    });
    const pending = env.store.complete("question", { signal: controller.signal });
    const rejected = assert.rejects(pending, /cancel preflight/u);
    await entered.promise;
    controller.abort(new Error("cancel preflight"));
    release.resolve();
    await rejected;
    mocked.mock.restore();
    assert.equal(env.requests.length, 0);
    await env.assertEmpty();
  }
});

test("completion reports cleanup failure instead of returning a successful answer", { timeout: 15000 }, async (t) => {
  const env = await fixture(t);
  t.mock.method(env.artifacts, "deleteSession", async () => { throw new Error("cleanup failed"); });
  const response = await env.post("question");
  assert.equal(response.status, 500);
  assert.match((await response.json() as { error: string }).error, /cleanup failed/u);
  assert.ok(env.events.some(({ event }) => event === "agent.completion.cleanup.failed"));
  await env.assertEmpty();
});
