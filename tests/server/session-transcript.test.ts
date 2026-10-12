import assert from "node:assert/strict";
import test from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import {
  serializeMessages,
  serializeSessionTranscript,
  type TranscriptSourceMessage,
} from "../../src/server/agent/agent-sessions.ts";

test("renders the full active branch after model context compaction", () => {
  const manager = SessionManager.inMemory();
  const append = (message: TranscriptSourceMessage): string => (
    manager.appendMessage(message as never)
  );

  append({ role: "user", content: "第一轮问题", timestamp: 1 });
  append({
    role: "assistant",
    content: [{ type: "text", text: "第一轮回答" }],
    stopReason: "stop",
    timestamp: 2,
  });
  const firstKeptEntryId = append({ role: "user", content: "第二轮问题", timestamp: 3 });
  append({
    role: "assistant",
    content: [{ type: "text", text: "第二轮回答" }],
    stopReason: "stop",
    timestamp: 4,
  });
  manager.appendCompaction("第一轮的压缩摘要", firstKeptEntryId, 40_000);

  assert.deepEqual(serializeMessages(manager.buildSessionContext().messages), [
    { id: "user-1", role: "user", text: "第二轮问题", timestamp: 3 },
    { id: "assistant-2", role: "assistant", text: "第二轮回答", timestamp: 4 },
  ]);
  assert.deepEqual(serializeSessionTranscript({ sessionManager: manager }), [
    { id: "user-1", role: "user", text: "第一轮问题", timestamp: 1 },
    { id: "assistant-2", role: "assistant", text: "第一轮回答", timestamp: 2 },
    { id: "user-3", role: "user", text: "第二轮问题", timestamp: 3 },
    { id: "assistant-4", role: "assistant", text: "第二轮回答", timestamp: 4 },
  ]);
});

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
        {
          type: "tool",
          id: "call-1",
          name: "execute_sql",
          arguments: { sql: "secret" },
          isError: false,
        },
        { type: "text", text: "然后按城市汇总。" },
        {
          type: "tool",
          id: "call-2",
          name: "execute_sql",
          arguments: { sql: "secret-2" },
          isError: true,
        },
      ],
    },
  ]);
  const serialized = JSON.stringify(serializeMessages(messages));
  assert.doesNotMatch(serialized, /不得传给前端/u);
  assert.match(serialized, /secret-2/u);
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

test("shows only the rewritten answer around a hidden image-reference review message", () => {
  assert.deepEqual(serializeMessages([
    { role: "user", content: "画图", timestamp: 1 },
    {
      role: "assistant",
      content: [{ type: "text", text: "保留原始引用的候选回答" }],
      stopReason: "stop",
      timestamp: 2,
    },
    {
      role: "custom",
      content: "隐藏的图片地址复核指令",
      timestamp: 3,
    },
    {
      role: "assistant",
      content: [{ type: "text", text: "复核后的最终回答" }],
      stopReason: "stop",
      timestamp: 4,
    },
  ]), [
    { id: "user-1", role: "user", text: "画图", timestamp: 1 },
    {
      id: "assistant-2",
      role: "assistant",
      text: "复核后的最终回答",
      timestamp: 4,
    },
  ]);
});

test("uses an empty object for legacy tool calls without arguments", () => {
  assert.deepEqual(serializeMessages([
    { role: "user", content: "现在几点" },
    {
      role: "assistant",
      content: [{ type: "toolCall", id: "time-1", name: "get_current_time" }],
      stopReason: "toolUse",
    },
    {
      role: "toolResult",
      toolCallId: "time-1",
      toolName: "get_current_time",
      isError: false,
    },
    { role: "assistant", content: [{ type: "text", text: "现在是十二点。" }], stopReason: "stop" },
  ]), [
    { id: "user-1", role: "user", text: "现在几点" },
    {
      id: "assistant-2",
      role: "assistant",
      text: "现在是十二点。",
      trace: [{
        type: "tool",
        id: "time-1",
        name: "get_current_time",
        arguments: {},
        isError: false,
      }],
    },
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

test("ignores legacy code interpreter images while preserving the final answer and tool trace", () => {
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
        images: [{
          mimeType: "image/png",
          data: png,
          alt: "oee-trend",
          referenceName: "oee-trend",
          referenceId: "ci-oee-trend",
        }],
      },
    },
    { role: "assistant", content: [{ type: "text", text: "趋势如下。" }], stopReason: "stop" },
  ]), [
    { id: "user-1", role: "user", text: "画图" },
    {
      id: "assistant-2",
      role: "assistant",
      text: "趋势如下。",
      trace: [{
        type: "tool",
        id: "code-1",
        name: "code_interpreter",
        arguments: {},
        isError: false,
      }],
    },
  ]);
});

test("ignores persisted images without consistent semantic metadata", () => {
  const png = Buffer.from("89504e470d0a1a0a", "hex").toString("base64");
  const transcript = serializeMessages([
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
        images: [
          { mimeType: "image/png", data: png, alt: "missing-metadata" },
          {
            mimeType: "image/png",
            data: png,
            alt: "old-reference",
            referenceName: "old-reference",
            referenceId: "ci:code-1:2",
          },
          {
            mimeType: "image/png",
            data: png,
            alt: "wrong-alt",
            referenceName: "semantic-name",
            referenceId: "ci-semantic-name",
          },
        ],
      },
    },
    { role: "assistant", content: "完成。", stopReason: "stop" },
  ]);

  assert.equal("images" in transcript.at(-1)!, false);
});

test("does not persist images from a failed code interpreter result", () => {
  const png = Buffer.from("89504e470d0a1a0a", "hex").toString("base64");
  const transcript = serializeMessages([
    { role: "user", content: "画图" },
    {
      role: "assistant",
      content: [{ type: "toolCall", id: "failed-code", name: "code_interpreter", arguments: {} }],
      stopReason: "toolUse",
    },
    {
      role: "toolResult",
      toolCallId: "failed-code",
      toolName: "code_interpreter",
      isError: true,
      details: {
        kind: "code_interpreter",
        images: [{ mimeType: "image/png", data: png, alt: "不得持久化" }],
      },
    },
    { role: "assistant", content: "生成失败。", stopReason: "stop" },
  ]);

  const tool = transcript.at(-1)?.trace?.at(-1);
  assert.equal("images" in transcript.at(-1)!, false);
  assert.equal(tool?.type, "tool");
  assert.equal(tool?.type === "tool" && tool.isError, true);
});

test("does not let a later reused tool-call ID satisfy an earlier missing result", () => {
  const png = Buffer.from("89504e470d0a1a0a", "hex").toString("base64");
  const transcript = serializeMessages([
    { role: "user", content: "第一轮" },
    {
      role: "assistant",
      content: [{ type: "toolCall", id: "reused", name: "code_interpreter", arguments: {} }],
      stopReason: "toolUse",
    },
    { role: "assistant", content: "第一轮没有结果。", stopReason: "stop" },
    { role: "user", content: "第二轮" },
    {
      role: "assistant",
      content: [{ type: "toolCall", id: "reused", name: "code_interpreter", arguments: {} }],
      stopReason: "toolUse",
    },
    {
      role: "toolResult",
      toolCallId: "reused",
      toolName: "code_interpreter",
      isError: false,
      details: {
        kind: "code_interpreter",
        images: [{
          mimeType: "image/png",
          data: png,
          alt: "second-turn-only",
          referenceName: "second-turn-only",
          referenceId: "ci-second-turn-only",
        }],
      },
    },
    { role: "assistant", content: "第二轮完成。", stopReason: "stop" },
  ]);
  const assistantMessages = transcript.filter((message) => message.role === "assistant");

  assert.equal("images" in assistantMessages[0]!, false);
  assert.equal(assistantMessages[0]?.trace?.find((item) => item.type === "tool")?.isError, true);
  assert.equal("images" in assistantMessages[1]!, false);
  assert.equal(assistantMessages[1]?.trace?.find((item) => item.type === "tool")?.isError, false);
});
