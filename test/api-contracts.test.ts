import assert from "node:assert/strict";
import test from "node:test";
import {
  ContractValidationError,
  decodeHealthResponse,
  decodeSchemaResponse,
  decodeSerializedSession,
  decodeSseEvent,
} from "../client/api-contracts.ts";

const validSession = {
  id: "session-12345678",
  title: "测试会话",
  model: { provider: "test-provider", id: "test-model", name: "Test Model" },
  tools: ["query_database", "execute_database"],
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

test("rejects malformed nested API and SSE payloads", () => {
  assert.throws(
    () => decodeSerializedSession({ ...validSession, messages: [{ role: "user" }] }),
    ContractValidationError,
  );
  assert.throws(
    () => decodeSseEvent("tool_end", { id: "call-1", name: "query_database", isError: "false" }),
    /isError/u,
  );
});

test("rejects nullable model state and private schema SQL", () => {
  assert.throws(
    () => decodeHealthResponse({
      ok: true,
      database: { engine: "SQLite", path: "demo.sqlite" },
      agent: {
        tools: ["query_database", "execute_database"],
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
