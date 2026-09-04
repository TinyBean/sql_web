import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { initializeOeeDatabase } from "../../scripts/database/initialize.ts";
import {
  decodeSseEvent,
  decodeDeleteSessionResponse,
  decodeErrorResponse,
  decodeHealthResponse,
  decodeSchemaResponse,
  decodeSessionsResponse,
  parseJson,
  type Decoder,
} from "../../src/client/api-contracts.ts";
import { AppDatabase } from "../../src/server/data/database.ts";
import {
  createWebServer,
  type StreamableAgentSession,
  type WebSessionPort,
} from "../../src/server/http-server.ts";
import type { ParsedSseEvent, SerializedSession } from "../../src/shared/contracts.ts";

const projectRoot = process.cwd();

async function fetchContract<ResponseBody>(
  url: string,
  decode: Decoder<ResponseBody>,
): Promise<ResponseBody> {
  const response = await fetch(url);
  return decode(parseJson(await response.text(), url), url);
}

async function createFixture(
  t: TestContext,
  sessionsOverride?: WebSessionPort,
): Promise<string> {
  const directory = mkdtempSync(path.join(tmpdir(), "sqlite-qa-http-"));
  const filePath = path.join(directory, "oee.sqlite");
  initializeOeeDatabase(filePath);
  const database = AppDatabase.open({ filePath });
  const sessions: WebSessionPort = sessionsOverride ?? {
    status: () => ({
      tools: ["execute_sql", "get_current_time"],
      codeInterpreter: { available: false, reason: "test sandbox unavailable" },
      model: { provider: "test-provider", model: "test-model" },
      availableModelCount: 0,
      activeSessionCount: 0,
    }),
    list: async () => [],
    create: async () => ({
      id: "fake-session",
      title: "新会话",
      model: null,
      tools: ["execute_sql", "get_current_time"],
      streaming: false,
      messages: [],
    }),
    get: async () => { throw new Error("not used in this test"); },
    getSerialized: async () => { throw new Error("not used in this test"); },
    delete: async () => {},
    prompt: async () => {},
    abort: async () => {},
  };
  const logger = { error() {} };
  const server = createWebServer({
    database,
    sessions,
    publicDir: path.join(projectRoot, "public"),
    vendorDir: path.join(projectRoot, "node_modules"),
    logger,
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string", "server should have a TCP address");
  const baseUrl = `http://127.0.0.1:${address.port}`;
  t.after(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
    database.close();
    rmSync(directory, { recursive: true, force: true });
  });
  return baseUrl;
}

function parseSseBody(body: string): ParsedSseEvent[] {
  const events: ParsedSseEvent[] = [];
  for (const block of body.split(/\r?\n\r?\n/u)) {
    let event = "message";
    const dataLines: string[] = [];
    for (const line of block.split(/\r?\n/u)) {
      if (line.startsWith("event:")) event = line.slice(6).trim();
      else if (line.startsWith("data:")) dataLines.push(line.slice(5).trimStart());
    }
    if (!dataLines.length) continue;
    const parsed = decodeSseEvent(event, parseJson(dataLines.join("\n"), `$sse.${event}`));
    if (parsed) events.push(parsed);
  }
  return events;
}

test("serves the app with restrictive security headers", async (t) => {
  const baseUrl = await createFixture(t);
  const response = await fetch(`${baseUrl}/`);
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-security-policy") ?? "", /default-src 'self'/u);
  const page = await response.text();
  assert.match(page, /DataLens/u);
  assert.ok(page.indexOf("/vendor/marked.js") < page.indexOf("/app.js"));
  assert.ok(page.indexOf("/vendor/dompurify.js") < page.indexOf("/app.js"));
  const contractModule = await fetch(`${baseUrl}/api-contracts.js`);
  assert.equal(contractModule.status, 200);
  assert.match(contractModule.headers.get("content-type") ?? "", /javascript/u);
  assert.match(await contractModule.text(), /\.\.\/shared\/contracts\.js/u);
  const sharedContractsModule = await fetch(`${baseUrl}/shared/contracts.js`);
  assert.equal(sharedContractsModule.status, 200);
  assert.match(sharedContractsModule.headers.get("content-type") ?? "", /javascript/u);
  assert.match(await sharedContractsModule.text(), /isAgentToolName/u);
  const streamStateModule = await fetch(`${baseUrl}/stream-state.js`);
  assert.equal(streamStateModule.status, 200);
  assert.match(streamStateModule.headers.get("content-type") ?? "", /javascript/u);
  const markdownModule = await fetch(`${baseUrl}/markdown.js`);
  assert.equal(markdownModule.status, 200);
  assert.match(markdownModule.headers.get("content-type") ?? "", /javascript/u);
  const imagePlaceholdersModule = await fetch(`${baseUrl}/image-placeholders.js`);
  assert.equal(imagePlaceholdersModule.status, 200);
  assert.match(imagePlaceholdersModule.headers.get("content-type") ?? "", /javascript/u);
  const markedVendor = await fetch(`${baseUrl}/vendor/marked.js`);
  assert.equal(markedVendor.status, 200);
  assert.match(await markedVendor.text(), /marked/u);
  const domPurifyVendor = await fetch(`${baseUrl}/vendor/dompurify.js`);
  assert.equal(domPurifyVendor.status, 200);
  assert.match(await domPurifyVendor.text(), /DOMPurify/u);
});

test("exposes health, schema, and session endpoints", async (t) => {
  const baseUrl = await createFixture(t);
  const health = await fetchContract(`${baseUrl}/api/health`, decodeHealthResponse);
  assert.deepEqual(health.agent.tools, ["execute_sql", "get_current_time"]);
  assert.deepEqual(health.agent.codeInterpreter, {
    available: false,
    reason: "test sandbox unavailable",
  });

  const schema = await fetchContract(`${baseUrl}/api/schema`, decodeSchemaResponse);
  assert.equal(schema.objects.some((object) => object.name === "oee_availability"), true);
  assert.equal(schema.objects.some((object) => "sql" in object), false);

  const sessions = await fetchContract(`${baseUrl}/api/sessions`, decodeSessionsResponse);
  assert.deepEqual(sessions, { sessions: [] });

  const deleted = await fetch(`${baseUrl}/api/sessions/fake-session`, { method: "DELETE" });
  assert.equal(deleted.status, 200);
  assert.deepEqual(decodeDeleteSessionResponse(await deleted.json()), { ok: true });
});

test("rejects non-JSON session creation requests", async (t) => {
  const baseUrl = await createFixture(t);
  const response = await fetch(`${baseUrl}/api/sessions`, { method: "POST" });
  assert.equal(response.status, 415);
  const payload = decodeErrorResponse(parseJson(await response.text()));
  assert.match(payload.error, /Content-Type/u);
});

test("streams ordered turn, text, and tool lifecycle events", async (t) => {
  const completedSession: SerializedSession = {
    id: "fake-session",
    title: "统计销售额",
    model: null,
    tools: ["execute_sql", "get_current_time"],
    streaming: false,
    messages: [
      { id: "user-1", role: "user", text: "统计销售额" },
      {
        id: "assistant-2",
        role: "assistant",
        text: "上海最高。",
        trace: [
          { type: "text", text: "先查询。" },
          { type: "tool", id: "call-1", name: "execute_sql", isError: false },
        ],
      },
    ],
  };
  const listeners = new Set<(event: AgentSessionEvent) => void>();
  const streamable: StreamableAgentSession = {
    isStreaming: false,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  const emit = (event: AgentSessionEvent): void => {
    for (const listener of listeners) listener(event);
  };
  const intermediateMessage = {
    role: "assistant",
    content: [
      { type: "text", text: "先查询。" },
      { type: "toolCall", id: "call-1", name: "execute_sql", arguments: { sql: "SELECT 1" } },
    ],
    stopReason: "toolUse",
  };
  const finalMessage = {
    role: "assistant",
    content: [{ type: "text", text: "上海最高。" }],
    stopReason: "stop",
  };
  const sessions: WebSessionPort = {
    status: () => ({
      tools: ["execute_sql", "get_current_time"],
      codeInterpreter: { available: false, reason: "test sandbox unavailable" },
      model: { provider: "test-provider", model: "test-model" },
      availableModelCount: 0,
      activeSessionCount: 1,
    }),
    list: async () => [],
    create: async () => completedSession,
    get: async () => streamable,
    getSerialized: async () => completedSession,
    delete: async () => {},
    prompt: async () => {
      emit({ type: "turn_start" } as AgentSessionEvent);
      emit({
        type: "message_update",
        assistantMessageEvent: { type: "text_delta", delta: "先查询。" },
        message: intermediateMessage,
      } as AgentSessionEvent);
      emit({
        type: "message_update",
        assistantMessageEvent: {
          type: "toolcall_end",
          toolCall: { id: "call-1", name: "execute_sql" },
        },
        message: intermediateMessage,
      } as AgentSessionEvent);
      emit({ type: "message_end", message: intermediateMessage } as AgentSessionEvent);
      emit({
        type: "tool_execution_start",
        toolCallId: "call-1",
        toolName: "execute_sql",
        args: {},
      } as AgentSessionEvent);
      emit({
        type: "tool_execution_end",
        toolCallId: "call-1",
        toolName: "execute_sql",
        result: {},
        isError: false,
      } as AgentSessionEvent);
      emit({
        type: "turn_end",
        message: intermediateMessage,
        toolResults: [],
      } as unknown as AgentSessionEvent);
      emit({ type: "turn_start" } as AgentSessionEvent);
      emit({
        type: "message_update",
        assistantMessageEvent: { type: "text_delta", delta: "上海最高。" },
        message: finalMessage,
      } as AgentSessionEvent);
      emit({ type: "message_end", message: finalMessage } as AgentSessionEvent);
      emit({
        type: "turn_end",
        message: finalMessage,
        toolResults: [],
      } as unknown as AgentSessionEvent);
    },
    abort: async () => {},
  };
  const baseUrl = await createFixture(t, sessions);
  const response = await fetch(`${baseUrl}/api/sessions/fake-session/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message: "统计销售额" }),
  });
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /text\/event-stream/u);
  const events = parseSseBody(await response.text());
  assert.deepEqual(events.map((event) => event.event), [
    "turn_start",
    "text_delta",
    "tool_call",
    "tool_start",
    "tool_end",
    "turn_end",
    "turn_start",
    "text_delta",
    "turn_end",
    "done",
  ]);
  assert.deepEqual(events.filter((event) => event.event === "turn_end"), [
    { event: "turn_end", data: { turn: 0, final: false } },
    { event: "turn_end", data: { turn: 1, final: true } },
  ]);
  assert.deepEqual(events.find((event) => event.event === "tool_end"), {
    event: "tool_end",
    data: { turn: 0, id: "call-1", name: "execute_sql", isError: false },
  });
});
