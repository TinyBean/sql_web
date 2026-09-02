import assert from "node:assert/strict";
import test from "node:test";
import {
  serializeMessages,
  type TranscriptSourceMessage,
} from "../src/agent-sessions.ts";

test("groups agent turns into one answer with an ordered persisted trace", () => {
  const messages: TranscriptSourceMessage[] = [
    { role: "user", content: [{ type: "text", text: "统计销售额" }], timestamp: 1 },
    { role: "assistant", content: [], stopReason: "error", errorMessage: "temporary", timestamp: 2 },
    {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "不得传给前端" },
        { type: "text", text: "先读取订单。" },
        { type: "toolCall", id: "call-1", name: "execute_sql", arguments: { sql: "secret" } },
        { type: "text", text: "然后按城市汇总。" },
        { type: "toolCall", id: "call-2", name: "execute_sql", arguments: { sql: "secret-2" } },
      ],
      stopReason: "toolUse",
      timestamp: 3,
    },
    { role: "toolResult", toolCallId: "call-1", toolName: "execute_sql", isError: false },
    { role: "toolResult", toolCallId: "call-2", toolName: "execute_sql", isError: true },
    {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "也不得传给前端" },
        { type: "text", text: "上海最高。" },
      ],
      stopReason: "stop",
      timestamp: 4,
    },
  ];

  assert.deepEqual(serializeMessages(messages), [
    { id: "user-1", role: "user", text: "统计销售额", timestamp: 1 },
    {
      id: "assistant-2",
      role: "assistant",
      text: "上海最高。",
      timestamp: 4,
      trace: [
        { type: "text", text: "先读取订单。" },
        { type: "tool", id: "call-1", name: "execute_sql", isError: false },
        { type: "text", text: "然后按城市汇总。" },
        { type: "tool", id: "call-2", name: "execute_sql", isError: true },
      ],
    },
  ]);
  const serialized = JSON.stringify(serializeMessages(messages));
  assert.doesNotMatch(serialized, /不得传给前端|secret/u);
});

test("keeps direct and truncated answers while omitting retry failures", () => {
  assert.deepEqual(serializeMessages([
    { role: "user", content: "你好", timestamp: 1 },
    { role: "assistant", content: [], stopReason: "error", errorMessage: "retry me", timestamp: 2 },
    { role: "assistant", content: [{ type: "text", text: "直接回答" }], stopReason: "length", timestamp: 3 },
  ]), [
    { id: "user-1", role: "user", text: "你好", timestamp: 1 },
    { id: "assistant-2", role: "assistant", text: "直接回答", timestamp: 3 },
  ]);
});

test("retains the last error when a run never produces a final answer", () => {
  assert.deepEqual(serializeMessages([
    { role: "user", content: "你好" },
    { role: "assistant", content: [], stopReason: "error", errorMessage: "连接失败" },
  ]), [
    { id: "user-1", role: "user", text: "你好" },
    { id: "assistant-2", role: "assistant", text: "连接失败" },
  ]);
});

test("associates persisted code interpreter PNG details with the final answer", () => {
  const png = Buffer.from("89504e470d0a1a0a", "hex").toString("base64");
  assert.deepEqual(serializeMessages([
    { role: "user", content: "画图" },
    {
      role: "assistant",
      content: [{ type: "toolCall", id: "code-1", name: "code_interpreter", arguments: {} }],
      stopReason: "toolUse",
    },
    {
      role: "toolResult",
      toolCallId: "code-1",
      toolName: "code_interpreter",
      isError: false,
      details: {
        kind: "code_interpreter",
        images: [{ mimeType: "image/png", data: png, alt: "趋势图" }],
      },
    },
    { role: "assistant", content: [{ type: "text", text: "趋势如下。" }], stopReason: "stop" },
  ]), [
    { id: "user-1", role: "user", text: "画图" },
    {
      id: "assistant-2",
      role: "assistant",
      text: "趋势如下。",
      trace: [{ type: "tool", id: "code-1", name: "code_interpreter", isError: false }],
      images: [{ mimeType: "image/png", data: png, alt: "趋势图" }],
    },
  ]);
});
