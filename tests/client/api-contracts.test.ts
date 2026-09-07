import assert from "node:assert/strict";
import test from "node:test";
import {
  ContractValidationError,
  decodeDeleteSessionResponse,
  decodeHealthResponse,
  decodeSchemaResponse,
  decodeSerializedSession,
  decodeSseEvent,
} from "../../src/client/api-contracts.ts";

const validSession = {
  id: "session-12345678",
  title: "测试会话",
  model: { provider: "test-provider", id: "test-model", name: "Test Model" },
  tools: [
    "read",
    "execute_sql",
    "get_current_time",
    "example_skill__calculate",
  ],
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
        {
          type: "tool",
          id: "call-1",
          name: "execute_sql",
          arguments: {
            sql: "SELECT ?\nFROM sales",
            parameters: [7, "上海", null, true],
            options: { output_format: "inline" },
          },
          isError: false,
        },
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
    decodeSseEvent("tool_call", {
      turn: 0,
      id: "call-1",
      name: "execute_sql",
      arguments: { sql: "SELECT 1" },
    }),
    {
      event: "tool_call",
      data: { turn: 0, id: "call-1", name: "execute_sql", arguments: { sql: "SELECT 1" } },
    },
  );
  assert.deepEqual(decodeSseEvent("turn_end", { turn: 1, final: true }), {
    event: "turn_end",
    data: { turn: 1, final: true },
  });
});

test("decodes automatic compaction lifecycle events", () => {
  for (const reason of ["threshold", "overflow"] as const) {
    assert.deepEqual(decodeSseEvent("compaction_start", { reason }), {
      event: "compaction_start",
      data: { reason },
    });
    for (const outcome of ["completed", "aborted", "failed"] as const) {
      assert.deepEqual(decodeSseEvent("compaction_end", { reason, outcome }), {
        event: "compaction_end",
        data: { reason, outcome },
      });
    }
  }
});

test("rejects invalid automatic compaction events and ignores unknown SSE events", () => {
  assert.throws(
    () => decodeSseEvent("compaction_start", { reason: "manual" }),
    /reason/u,
  );
  assert.throws(
    () => decodeSseEvent("compaction_start", { reason: "unexpected" }),
    /reason/u,
  );
  assert.throws(
    () => decodeSseEvent("compaction_start", { reason: 1 }),
    /reason/u,
  );
  assert.throws(
    () => decodeSseEvent("compaction_end", { reason: "overflow", outcome: "unknown" }),
    /outcome/u,
  );
  assert.throws(
    () => decodeSseEvent("compaction_end", { reason: "overflow", outcome: false }),
    /outcome/u,
  );
  assert.equal(decodeSseEvent("future_event", {}), null);
});

test("decodes code interpreter tools and inline PNG images", () => {
  const session = {
    ...validSession,
    tools: [
      "read",
      "execute_sql",
      "get_current_time",
      "example_skill__calculate",
      "code_interpreter",
    ],
    messages: [{
      id: "assistant-1",
      role: "assistant",
      text: "图表",
      images: [{ id: "ci:call-1:1", mimeType: "image/png", data: "iVBORw0KGgo=", alt: "趋势图" }],
    }],
  };
  assert.deepEqual(decodeSerializedSession(session), session);
});

test("decodes generated image stream events", () => {
  const image = {
    id: "ci:call-1:1",
    mimeType: "image/png",
    data: "iVBORw0KGgo=",
    alt: "趋势图",
  };
  assert.deepEqual(
    decodeSseEvent("generated_image", { turn: 2, toolCallId: "call-1", image }),
    {
      event: "generated_image",
      data: { turn: 2, toolCallId: "call-1", image },
    },
  );
});

test("rejects malformed generated image stream events", () => {
  const image = {
    id: "ci:call-1:1",
    mimeType: "image/png",
    data: "iVBORw0KGgo=",
    alt: "趋势图",
  };
  assert.throws(
    () => decodeSseEvent("generated_image", { turn: -1, toolCallId: "call-1", image }),
    /turn/u,
  );
  assert.throws(
    () => decodeSseEvent("generated_image", { toolCallId: "call-1", image }),
    /turn/u,
  );
  assert.throws(
    () => decodeSseEvent("generated_image", { turn: 0, image }),
    /toolCallId/u,
  );
  assert.throws(
    () => decodeSseEvent("generated_image", { turn: 0, toolCallId: "   ", image }),
    /toolCallId/u,
  );
  assert.throws(
    () => decodeSseEvent("generated_image", { turn: 0, toolCallId: "call-1" }),
    /image/u,
  );
  assert.throws(
    () => decodeSseEvent("generated_image", {
      turn: 0,
      toolCallId: "call-1",
      image: { ...image, id: "" },
    }),
    /image\.id/u,
  );
  assert.throws(
    () => decodeSseEvent("generated_image", {
      turn: 0,
      toolCallId: "call-1",
      image: { ...image, mimeType: "image/jpeg" },
    }),
    /image\.mimeType/u,
  );
  assert.throws(
    () => decodeSseEvent("generated_image", {
      turn: 0,
      toolCallId: "call-1",
      image: { ...image, alt: null },
    }),
    /image\.alt/u,
  );
});

test("rejects malformed nested API and SSE payloads", () => {
  assert.throws(
    () => decodeSerializedSession({ ...validSession, tools: ["Invalid-Tool"] }),
    /工具名/u,
  );
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
    () => decodeSerializedSession({
      ...validSession,
      messages: [{
        id: "assistant-1",
        role: "assistant",
        text: "图表",
        images: [{ id: "", mimeType: "image/png", data: "iVBORw0KGgo=", alt: "趋势图" }],
      }],
    }),
    /images\[0\]\.id/u,
  );
  assert.throws(
    () => decodeSerializedSession({
      ...validSession,
      messages: [{
        id: "assistant-1",
        role: "assistant",
        text: "图表",
        images: [
          { id: "ci:call-1:1", mimeType: "image/png", data: "AAAA", alt: "第一张" },
          { id: "ci:call-1:1", mimeType: "image/png", data: "BBBB", alt: "第二张" },
        ],
      }],
    }),
    /images\[1\]\.id/u,
  );
  assert.throws(
    () => decodeSseEvent("tool_call", {
      turn: 0,
      id: "call-1",
      name: "execute_sql",
      arguments: { sql: undefined },
    }),
    /合法 JSON 值/u,
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
