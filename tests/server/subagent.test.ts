import assert from "node:assert/strict";
import { once } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { initializeOeeDatabase } from "../../scripts/database/initialize.ts";
import { AgentSessionStore } from "../../src/server/agent/agent-sessions.ts";
import { loadAgentSkillCatalog } from "../../src/server/agent/skill-catalog.ts";
import { SubagentRunner, type SubagentResult, type SubagentRunnerOptions } from "../../src/server/agent/subagent.ts";
import { AppDatabase } from "../../src/server/database/database.ts";
import { createDefaultDashboard } from "../../src/server/dashboard/default/template.ts";
import { AnalysisToolCallBudget } from "../../src/server/dashboard/default/analysis/budget.ts";
import { ArtifactStore } from "../../src/server/tool/artifact-store.ts";
import { createAgentTools } from "../../src/server/tool/database-tools.ts";
import { CodeInterpreterRuntime } from "../../src/server/tool/code-interpreter.ts";

interface RequestBody {
  messages: { role: string; content: string | { type: string; text?: string }[]; tool_calls?: unknown[] }[];
  tools: { function: { name: string } }[];
}
const call = (name: string, args: unknown, id = "repeated-id") =>
  [{ index: 0, id, type: "function", function: { name, arguments: JSON.stringify(args) } }];
const messageText = (content: RequestBody["messages"][number]["content"]): string =>
  typeof content === "string" ? content : Array.isArray(content) ? content.map((part) => part.text ?? "").join("") : "";
const toolResults = (body: RequestBody) => body.messages.filter((message) => message.role === "tool")
  .map((message) => ({ ...message, content: messageText(message.content) }));
const taskFor = (body: RequestBody): string => {
  const user = body.messages.findLast((message) => message.role === "user");
  try { return (JSON.parse(messageText(user?.content ?? "{}")) as { task: string }).task; } catch { return "parent"; }
};

async function fixture(t: TestContext, respond: (body: RequestBody) => unknown | Promise<unknown>) {
  const directory = mkdtempSync(path.join(tmpdir(), "sql-web-subagents-"));
  const requests: RequestBody[] = [];
  const serverErrors: unknown[] = [];
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString()) as RequestBody;
    requests.push(body);
    try {
      const result = await respond(body);
      if (result instanceof Error) { response.writeHead(400); response.end(JSON.stringify({ error: { message: result.message } })); return; }
      const calls = typeof result === "string" ? null : result;
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end("data: " + JSON.stringify({
        id: "completion", object: "chat.completion.chunk", choices: [{ index: 0,
          delta: { role: "assistant", ...(calls ? { tool_calls: calls } : { content: result }) }, finish_reason: null }],
      }) + "\n\ndata: " + JSON.stringify({ id: "completion", choices: [{ index: 0, delta: {}, finish_reason: calls ? "tool_calls" : "stop" }],
        usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
      }) + "\n\ndata: [DONE]\n\n");
    } catch (error) { serverErrors.push(error); response.writeHead(500); response.end(String(error)); }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const agentDir = path.join(directory, "agent");
  mkdirSync(agentDir);
  writeFileSync(path.join(agentDir, "models.json"), JSON.stringify({ providers: { test: {
    baseUrl: `http://127.0.0.1:${address.port}/v1`, api: "openai-completions", apiKey: "test-only",
    models: [{ id: "test-model", name: "Test", reasoning: false, contextWindow: 128000, maxTokens: 8192 }],
  } } }));
  const filePath = path.join(directory, "test.sqlite");
  initializeOeeDatabase(filePath);
  const database = AppDatabase.open({ filePath });
  const interpreter = await CodeInterpreterRuntime.create({ projectRoot: directory,
    pythonPath: "/nonexistent/python", bwrapPath: "/nonexistent/bwrap", prlimitPath: "/nonexistent/prlimit" });
  const artifacts = new ArtifactStore(path.join(directory, "artifacts"));
  const events: Record<string, unknown>[] = [];
  const store = await AgentSessionStore.open({ database, artifacts, codeInterpreter: interpreter, cwd: directory,
    sessionDir: path.join(directory, "sessions"), agentDir, model: { provider: "test", model: "test-model" },
    logger: { info: (event, fields) => { if (event === "agent.subagent.event") events.push({ ...fields }); }, warn() {}, error() {} },
    loadInitialDashboard: () => createDefaultDashboard() });
  const created = await store.create();
  const parent = await store.get(created.id);
  const catalog = await loadAgentSkillCatalog();
  const runners: SubagentRunner[] = [];
  const makeRunner = (overrides: Partial<SubagentRunnerOptions> = {}) => {
    const runner = new SubagentRunner({ cwd: directory, agentDir, parent: () => parent, catalog,
      onEvent: (event) => events.push(event),
      prepareBatch: () => (id) => ({ systemPrompt: "只读调查", context: () => ({ marker: "provided-context" }),
        tools: createAgentTools(database, artifacts.forSession(created.id).scoped(id), interpreter, new Set(), undefined, true) }),
      ...overrides });
    runners.push(runner);
    return runner;
  };
  t.after(async () => {
    await Promise.all(runners.map((runner) => runner.dispose()));
    await store.dispose();
    database.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(directory, { recursive: true, force: true });
    assert.deepEqual(serverErrors, [], "mock model assertions failed");
  });
  return { store, created, parent, artifacts: artifacts.forSession(created.id), makeRunner, requests, events, directory };
}

test("website delegates three concurrent isolated tasks, preserves ordered partial results and parent snapshots", { timeout: 15000 }, async (t) => {
  let inFlight = 0;
  let maxInFlight = 0;
  let release!: () => void;
  const allStarted = new Promise<void>((resolve) => { release = resolve; });
  let returned: SubagentResult[] = [];
  const env = await fixture(t, async (body) => {
    const task = taskFor(body);
    const results = toolResults(body);
    if (task === "parent") {
      if (!results.length) return call("subagent", { tasks: ["first", "second", "failed"].map((name) => ({ name, task: name })), context: "explicit background" });
      returned = (JSON.parse(results.at(-1)!.content) as { results: SubagentResult[] }).results;
      return "主 Agent 汇总结论";
    }
    assert.doesNotMatch(JSON.stringify(body.messages), /parent-secret/u);
    assert.match(JSON.stringify(body.messages), /explicit background/u);
    const tools = body.tools.map((tool) => tool.function.name);
    assert.deepEqual(tools.sort(), ["execute_sql", "get_current_time", "measure_loss", "read"]);
    if (!results.length) {
      inFlight += 1; maxInFlight = Math.max(maxInFlight, inFlight);
      if (inFlight === 3) release();
      await allStarted;
      inFlight -= 1;
      if (task === "failed") return new Error("simulated child failure");
      return call("execute_sql", { sql: task === "first" ? "SELECT 11 AS value" : "SELECT 22 AS value", save_as: "123456789-analysis" });
    }
    return "调查完成 " + task;
  });
  await env.parent.getToolDefinition("execute_sql")!.execute("parent-snapshot", { sql: "SELECT 99 AS value", save_as: "123456789-analysis" }, undefined, undefined, undefined as never);
  await env.store.prompt(env.created.id, "parent-secret：请委派调查");
  assert.equal(maxInFlight, 3, JSON.stringify(returned));
  assert.deepEqual(returned.map((entry) => entry.name), ["first", "second", "failed"]);
  assert.deepEqual(returned.map((entry) => entry.status), ["completed", "completed", "failed"]);
  const snapshots = returned.slice(0, 2).map((entry) => entry.snapshots[0]!);
  assert.notEqual(snapshots[0]!.name, snapshots[1]!.name);
  assert.deepEqual(snapshots.map((snapshot) => JSON.parse(readFileSync(env.artifacts.resolveDataSnapshot(snapshot.name).filePath, "utf8")).rows[0].value), [11, 22]);
  assert.equal(returned[0]!.usage.toolCalls, 1);
  assert.equal(JSON.parse(readFileSync(env.artifacts.resolveDataSnapshot("123456789-analysis").filePath, "utf8")).rows[0].value, 99);
  assert.ok(returned[0]!.usage.inputTokens > 0);
  const serialized = await env.store.getSerialized(env.created.id);
  assert.equal(serialized.messages.at(-1)!.text, "主 Agent 汇总结论");
  assert.ok(serialized.messages.at(-1)!.trace?.some((entry) => entry.type === "tool" && entry.name === "subagent"));
  assert.equal((await env.store.list()).length, 1);
  assert.equal(readdirSync(path.join(env.directory, "sessions")).filter((name) => name.endsWith(".jsonl")).length, 1);
});

test("Skill activation is local to one child and unregistered recursion never executes", async (t) => {
  let skillPath = "";
  const env = await fixture(t, (body) => {
    const task = taskFor(body);
    const results = toolResults(body);
    if (task === "reader") {
      if (!results.length) return call("read", { path: skillPath });
      assert.ok(body.tools.some((tool) => tool.function.name === "test_oee_calculator__get_sql_expressions"));
      return "已读取口径";
    }
    assert.ok(!body.tools.some((tool) => tool.function.name.startsWith("test_oee_calculator__")));
    if (!results.length) return call("subagent", { tasks: [{ name: "recursive", task: "forbidden" }] });
    assert.match(results[0]!.content, /not found/u);
    return "无法继续委派";
  });
  skillPath = /<location>([^<]+)<\/location>/u.exec(env.parent.systemPrompt)![1]!;
  const result = await env.makeRunner().run("parent-call", { tasks: [{ name: "reader", task: "reader" }, { name: "other", task: "other" }] });
  assert.deepEqual(result.map((entry) => entry.status), ["completed", "completed"]);
  assert.ok(env.events.some((event) => event["type"] === "tool_call" && event["name"] === "read"));
  assert.equal(env.parent.getToolDefinition("test_oee_calculator__get_sql_expressions"), undefined);
  assert.equal(existsSync(env.parent.sessionFile!), false);
});

test("child limit counts invalid schemas and unknown tools, including reused call IDs", async (t) => {
  const env = await fixture(t, (body) => toolResults(body).length % 2
    ? call("unknown_tool", {}) : call("execute_sql", {}));
  const result = await env.makeRunner().run("budget", { tasks: [{ name: "loop", task: "loop" }] });
  assert.equal(result[0]!.status, "budget_exhausted");
  assert.equal(result[0]!.usage.toolCalls, 12);
  assert.equal(env.events.filter((event) => event["type"] === "tool_call").length, 12);
  assert.equal(env.events.filter((event) => event["type"] === "tool_result").length, 12);
});

test("parallel children cannot consume the eight parent-reserved analysis slots", async (t) => {
  const budget = new AnalysisToolCallBudget();
  for (let n = 0; n < 50; n++) assert.equal(budget.take(), true);
  const env = await fixture(t, () => call("unknown_tool", {}));
  const result = await env.makeRunner({ tryConsumeTool: () => budget.take(true), remainingTools: () => budget.remainingForChildren })
    .run("shared-budget", { tasks: ["a", "b", "c"].map((name) => ({ name, task: name })) });
  assert.ok(result.every((entry) => entry.status === "budget_exhausted"));
  assert.equal(result.reduce((sum, entry) => sum + entry.usage.toolCalls, 0), 2);
  assert.equal(budget.used, 52);
  for (let n = 0; n < 8; n++) assert.equal(budget.take(), true);
  assert.equal(budget.take(), false);
  assert.equal(budget.used, 60);
});

for (const reason of ["abort", "dispose", "timeout", "deadline", "parent_timeout"] as const) {
  test(`child ${reason} cancels the pending model request and cleans up before returning`, { timeout: 10000 }, async (t) => {
    let started!: () => void;
    const requestStarted = new Promise<void>((resolve) => { started = resolve; });
    let release!: () => void;
    const blocked = new Promise<string>((resolve) => { release = () => resolve("late result"); });
    t.after(() => release());
    const env = await fixture(t, () => { started(); return blocked; });
    const controller = new AbortController();
    const runner = env.makeRunner(reason === "timeout" ? { timeoutMs: 150 }
      : reason === "deadline" ? { deadline: Date.now() + 150 }
        : reason === "parent_timeout" ? { signal: AbortSignal.timeout(150), deadline: Date.now() + 150 } : {});
    const pending = runner.run("cancel", { tasks: [{ name: "blocked", task: "blocked" }] }, controller.signal);
    if (reason === "abort" || reason === "dispose") await requestStarted;
    if (reason === "abort") controller.abort();
    if (reason === "dispose") await runner.dispose();
    const [result] = await pending;
    assert.equal(result!.status, reason === "abort" || reason === "dispose" ? "aborted" : "timed_out");
    assert.equal(result!.text, "");
    assert.ok(result!.error);
    release();
  });
}

for (const reason of ["abort", "dispose"] as const) {
  test(`website ${reason} propagates to all three children and waits for their cleanup`, { timeout: 10000 }, async (t) => {
    let started!: () => void;
    const allStarted = new Promise<void>((resolve) => { started = resolve; });
    let release!: () => void;
    const blocked = new Promise<string>((resolve) => { release = () => resolve("late reply"); });
    t.after(() => release());
    let children = 0;
    const env = await fixture(t, (body) => {
      if (taskFor(body) === "parent") return call("subagent", { tasks: ["a", "b", "c"].map((name) => ({ name, task: name })) });
      children += 1;
      if (children === 3) started();
      return blocked;
    });
    const prompt = env.store.prompt(env.created.id, "请委派调查并等待");
    await allStarted;
    if (reason === "abort") await env.store.abort(env.created.id);
    else await env.store.dispose();
    await prompt;
    const completed = env.events.filter((event) => event["type"] === "subagent_result");
    assert.equal(completed.length, 3);
    assert.ok(completed.every((event) => (event["result"] as SubagentResult).status === "aborted"));
    release();
  });
}
