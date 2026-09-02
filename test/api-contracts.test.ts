import assert from "node:assert/strict";
import test from "node:test";
import {
  ContractValidationError,
  decodeDeleteSessionResponse,
  decodeHealthResponse,
  decodeSchemaResponse,
  decodeSerializedSession,
  decodeSseEvent,
} from "../client/api-contracts.ts";

const validSession = {
  id: "session-12345678",
  title: "测试会话",
  model: { provider: "test-provider", id: "test-model", name: "Test Model" },
  tools: ["execute_sql", "get_current_time"],
  streaming: false,
  messages: [{ id: "user-1", role: "user", text: "你好", timestamp: 1 }],
};

test("decodes a complete session without type assertions", () => {
  assert.deepEqual(decodeSerializedSession(validSession), validSession);
  assert.deepEqual(decodeSseEvent("done", validSession), {
    event: "done",
    data: validSession,
  });
});

test("decodes a successful session deletion", () => {
  assert.deepEqual(decodeDeleteSessionResponse({ ok: true }), { ok: true });
  assert.throws(() => decodeDeleteSessionResponse({ ok: false }), /ok/u);
});

test("decodes ordered turn events and persisted trace items", () => {
  const sessionWithTrace = {
    ...validSession,
    messages: [{
      id: "assistant-2",
      role: "assistant",
      text: "最终回答",
      trace: [
        { type: "text", text: "先查询" },
        { type: "tool", id: "call-1", name: "execute_sql", isError: false },
      ],
    }],
  };
  assert.deepEqual(decodeSerializedSession(sessionWithTrace), sessionWithTrace);
  assert.deepEqual(decodeSseEvent("turn_start", { turn: 0 }), {
    event: "turn_start",
    data: { turn: 0 },
  });
  assert.deepEqual(decodeSseEvent("text_delta", { turn: 0, delta: "先查询" }), {
    event: "text_delta",
    data: { turn: 0, delta: "先查询" },
  });
  assert.deepEqual(
    decodeSseEvent("tool_call", { turn: 0, id: "call-1", name: "execute_sql" }),
    { event: "tool_call", data: { turn: 0, id: "call-1", name: "execute_sql" } },
  );
  assert.deepEqual(decodeSseEvent("turn_end", { turn: 1, final: true }), {
    event: "turn_end",
    data: { turn: 1, final: true },
  });
});

test("decodes code interpreter tools and inline PNG images", () => {
  const session = {
    ...validSession,
    tools: ["execute_sql", "get_current_time", "code_interpreter"],
    messages: [{
      id: "assistant-1",
      role: "assistant",
      text: "图表",
      images: [{ mimeType: "image/png", data: "iVBORw0KGgo=", alt: "趋势图" }],
    }],
  };
  assert.deepEqual(decodeSerializedSession(session), session);
});

test("rejects malformed nested API and SSE payloads", () => {
  assert.throws(
    () => decodeSerializedSession({ ...validSession, messages: [{ role: "user" }] }),
    ContractValidationError,
  );
  assert.throws(
    () => decodeSseEvent("tool_end", {
      turn: 0,
      id: "call-1",
      name: "execute_sql",
      isError: "false",
    }),
    /isError/u,
  );
  assert.throws(
    () => decodeSseEvent("turn_end", { turn: -1, final: true }),
    /turn/u,
  );
  assert.throws(
    () => decodeSerializedSession({
      ...validSession,
      messages: [{ id: "assistant-1", role: "assistant", text: "回答", trace: [{ type: "tool" }] }],
    }),
    /id/u,
  );
});

test("rejects nullable model state and private schema SQL", () => {
  assert.throws(
    () => decodeHealthResponse({
      ok: true,
      database: { engine: "SQLite", path: "oee.sqlite" },
      agent: {
        tools: ["execute_sql", "get_current_time"],
        codeInterpreter: { available: false, reason: "unavailable in test" },
        model: { provider: null, model: null },
        availableModelCount: 0,
        activeSessionCount: 0,
      },
    }),
    /provider/u,
  );
  assert.throws(
    () => decodeSchemaResponse({
      objects: [{ type: "table", name: "secret", sql: "CREATE TABLE secret", columns: [] }],
    }),
    /不得包含建表 SQL/u,
  );
});
