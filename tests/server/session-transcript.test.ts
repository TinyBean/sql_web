import assert from "node:assert/strict";
import test from "node:test";
import {
  serializeMessages,
  type TranscriptSourceMessage,
} from "../../src/server/agent/agent-sessions.ts";

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
      images: [{ id: "ci-oee-trend", mimeType: "image/png", data: png, alt: "oee-trend" }],
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

  assert.equal(transcript.at(-1)?.images, undefined);
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
  assert.equal(transcript.at(-1)?.images, undefined);
  assert.equal(tool?.type, "tool");
  assert.equal(tool?.type === "tool" && tool.isError, true);
});

test("keeps generated image IDs in tool-call source order", () => {
  const png = Buffer.from("89504e470d0a1a0a", "hex").toString("base64");
  const transcript = serializeMessages([
    { role: "user", content: "画两组图" },
    {
      role: "assistant",
      content: [
        { type: "toolCall", id: "code-first", name: "code_interpreter", arguments: {} },
        { type: "toolCall", id: "code-second", name: "code_interpreter", arguments: {} },
      ],
      stopReason: "toolUse",
    },
    {
      role: "toolResult",
      toolCallId: "code-second",
      toolName: "code_interpreter",
      isError: false,
      details: {
        kind: "code_interpreter",
        images: [{
          mimeType: "image/png",
          data: png,
          alt: "second-group",
          referenceName: "second-group",
          referenceId: "ci-second-group",
        }],
      },
    },
    {
      role: "toolResult",
      toolCallId: "code-first",
      toolName: "code_interpreter",
      isError: false,
      details: {
        kind: "code_interpreter",
        images: [
          {
            mimeType: "image/png",
            data: png,
            alt: "first-group-one",
            referenceName: "first-group-one",
            referenceId: "ci-first-group-one",
          },
          {
            mimeType: "image/png",
            data: png,
            alt: "first-group-two",
            referenceName: "first-group-two",
            referenceId: "ci-first-group-two",
          },
        ],
      },
    },
    { role: "assistant", content: "图表如下。", stopReason: "stop" },
  ]);

  const images = transcript.find((message) => message.role === "assistant")?.images;
  assert.deepEqual(images?.map((image) => image.id), [
    "ci-first-group-one",
    "ci-first-group-two",
    "ci-second-group",
  ]);
  assert.deepEqual(serializeMessages([
    { role: "user", content: "画图" },
    {
      role: "assistant",
      content: [{ type: "toolCall", id: "stable", name: "code_interpreter", arguments: {} }],
      stopReason: "toolUse",
    },
    {
      role: "toolResult",
      toolCallId: "stable",
      toolName: "code_interpreter",
      isError: false,
      details: {
        kind: "code_interpreter",
        images: [{
          mimeType: "image/png",
          data: png,
          alt: "stable-chart",
          referenceName: "stable-chart",
          referenceId: "ci-stable-chart",
        }],
      },
    },
    { role: "assistant", content: "完成。", stopReason: "stop" },
  ]).at(-1)?.images?.[0]?.id, "ci-stable-chart");
});

test("does not cross-wire images when historical tool-call IDs repeat across turns", () => {
  const png = Buffer.from("89504e470d0a1a0a", "hex").toString("base64");
  const transcript = serializeMessages([
    { role: "user", content: "第一轮" },
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
          alt: "first-turn",
          referenceName: "first-turn",
          referenceId: "ci-first-turn",
        }],
      },
    },
    { role: "assistant", content: "第一轮完成。", stopReason: "stop" },
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
          alt: "second-turn",
          referenceName: "second-turn",
          referenceId: "ci-second-turn",
        }],
      },
    },
    { role: "assistant", content: "第二轮完成。", stopReason: "stop" },
  ]);

  assert.deepEqual(
    transcript.filter((message) => message.role === "assistant").map((message) => (
      message.images?.map((image) => image.alt)
    )),
    [["first-turn"], ["second-turn"]],
  );
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

  assert.equal(assistantMessages[0]?.images, undefined);
  assert.equal(assistantMessages[0]?.trace?.find((item) => item.type === "tool")?.isError, true);
  assert.deepEqual(assistantMessages[1]?.images?.map((image) => image.alt), ["second-turn-only"]);
  assert.equal(assistantMessages[1]?.trace?.find((item) => item.type === "tool")?.isError, false);
});
