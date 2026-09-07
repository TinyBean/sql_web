import assert from "node:assert/strict";
import test from "node:test";
import {
  createStreamPresentation,
  formatToolArguments,
  formatToolStatusText,
  latestAssistantAfterLastUser,
  reduceStreamPresentation,
  settleStreamPresentation,
} from "../../src/client/stream-state.ts";

test("does not reuse an older image answer when the latest user turn has no assistant", () => {
  const previousAnswer = {
    id: "assistant-2",
    role: "assistant" as const,
    text: "上一轮图表",
    images: [{
      id: "ci:old:1",
      mimeType: "image/png" as const,
      data: "OLD_IMAGE",
      alt: "旧图",
    }],
  };
  const messages = [
    { id: "user-1", role: "user" as const, text: "上一轮" },
    previousAnswer,
    { id: "user-3", role: "user" as const, text: "本轮立即中止" },
  ];

  assert.equal(latestAssistantAfterLastUser(messages), undefined);
  const currentAnswer = { id: "assistant-4", role: "assistant" as const, text: "本轮完成" };
  assert.equal(latestAssistantAfterLastUser([...messages, currentAnswer]), currentAnswer);
});

test("formats raw tool names with every execution status", () => {
  assert.deepEqual(
    ([
      "execute_sql",
      "example_skill__calculate",
    ] as const)
      .flatMap((name) => (
      (["queued", "running", "done", "error"] as const).map((status) => ({
        name,
        status,
        label: `${name} · ${formatToolStatusText(name, status)}`,
      }))
    )),
    [
      { name: "execute_sql", status: "queued", label: "execute_sql · 准备执行工具" },
      { name: "execute_sql", status: "running", label: "execute_sql · 正在执行工具" },
      { name: "execute_sql", status: "done", label: "execute_sql · 工具执行完成" },
      { name: "execute_sql", status: "error", label: "execute_sql · 工具执行失败" },
      { name: "example_skill__calculate", status: "queued", label: "example_skill__calculate · 准备执行工具" },
      { name: "example_skill__calculate", status: "running", label: "example_skill__calculate · 正在执行工具" },
      { name: "example_skill__calculate", status: "done", label: "example_skill__calculate · 工具执行完成" },
      { name: "example_skill__calculate", status: "error", label: "example_skill__calculate · 工具执行失败" },
    ],
  );
});

test("formats complete tool arguments as indented JSON", () => {
  assert.equal(formatToolArguments({}), "{}");
  assert.equal(
    formatToolArguments({ sql: "SELECT *\nFROM sales", parameters: [1, null] }),
    '{\n  "sql": "SELECT *\\nFROM sales",\n  "parameters": [\n    1,\n    null\n  ]\n}',
  );
});

test("preserves text/tool order and promotes only the final turn", () => {
  let state = createStreamPresentation();
  state = reduceStreamPresentation(state, { event: "turn_start", data: { turn: 0 } });
  state = reduceStreamPresentation(state, { event: "text_delta", data: { turn: 0, delta: "先" } });
  state = reduceStreamPresentation(state, { event: "text_delta", data: { turn: 0, delta: "查询" } });
  state = reduceStreamPresentation(state, {
    event: "tool_call",
    data: {
      turn: 0,
      id: "call-1",
      name: "execute_sql",
      arguments: { sql: "SELECT 1", parameters: [1] },
    },
  });
  state = reduceStreamPresentation(state, {
    event: "tool_start",
    data: { turn: 0, id: "call-1", name: "execute_sql" },
  });
  state = reduceStreamPresentation(state, {
    event: "tool_end",
    data: { turn: 0, id: "call-1", name: "execute_sql", isError: false },
  });
  state = reduceStreamPresentation(state, { event: "turn_end", data: { turn: 0, final: false } });
  state = reduceStreamPresentation(state, { event: "turn_start", data: { turn: 1 } });
  state = reduceStreamPresentation(state, { event: "text_delta", data: { turn: 1, delta: "最终" } });
  state = reduceStreamPresentation(state, { event: "text_delta", data: { turn: 1, delta: "回答" } });

  assert.equal(state.finalText, "");
  assert.equal(state.currentTurnText, "最终回答");
  assert.deepEqual(state.items, [
    { type: "text", turn: 0, text: "先查询" },
    {
      type: "tool",
      turn: 0,
      id: "call-1",
      name: "execute_sql",
      arguments: { sql: "SELECT 1", parameters: [1] },
      status: "done",
    },
  ]);

  state = reduceStreamPresentation(state, { event: "turn_end", data: { turn: 1, final: true } });
  assert.equal(state.finalText, "最终回答");
  assert.equal(state.currentTurnText, "");
  assert.equal(state.finalized, true);
  assert.deepEqual(state.items, [
    { type: "text", turn: 0, text: "先查询" },
    {
      type: "tool",
      turn: 0,
      id: "call-1",
      name: "execute_sql",
      arguments: { sql: "SELECT 1", parameters: [1] },
      status: "done",
    },
  ]);
});

test("keeps incomplete thought content expanded on errors", () => {
  let state = createStreamPresentation();
  assert.equal(state.settled, false);
  state = reduceStreamPresentation(state, { event: "turn_start", data: { turn: 0 } });
  state = reduceStreamPresentation(state, { event: "text_delta", data: { turn: 0, delta: "处理中" } });
  state = reduceStreamPresentation(state, { event: "error", data: { message: "失败" } });
  assert.equal(state.failed, true);
  assert.equal(state.settled, true);
  assert.equal(state.compactingReason, null);
  assert.equal(state.finalized, false);
  assert.equal(state.finalText, "");
  assert.equal(state.currentTurnText, "处理中");
  assert.deepEqual(state.items, []);

  const errored = state;
  state = reduceStreamPresentation(state, {
    event: "turn_end",
    data: { turn: 0, final: true },
  });
  assert.equal(state, errored);
  assert.equal(state.finalText, "");
  assert.equal(state.currentTurnText, "处理中");
});

test("flushes each live draft before tools and at a non-final turn end", () => {
  let state = createStreamPresentation();
  state = reduceStreamPresentation(state, { event: "turn_start", data: { turn: 0 } });
  state = reduceStreamPresentation(state, {
    event: "text_delta",
    data: { turn: 0, delta: "准备查询" },
  });
  assert.equal(state.currentTurnText, "准备查询");
  assert.deepEqual(state.items, []);

  state = reduceStreamPresentation(state, {
    event: "tool_start",
    data: { turn: 0, id: "call-1", name: "execute_sql" },
  });
  assert.equal(state.currentTurnText, "");
  assert.deepEqual(state.items, [
    { type: "text", turn: 0, text: "准备查询" },
    {
      type: "tool",
      turn: 0,
      id: "call-1",
      name: "execute_sql",
      arguments: {},
      status: "running",
    },
  ]);

  state = reduceStreamPresentation(state, {
    event: "text_delta",
    data: { turn: 0, delta: "继续分析" },
  });
  assert.equal(state.currentTurnText, "继续分析");
  assert.deepEqual(state.items.at(-1), {
    type: "tool",
    turn: 0,
    id: "call-1",
    name: "execute_sql",
    arguments: {},
    status: "running",
  });
  state = reduceStreamPresentation(state, {
    event: "tool_end",
    data: { turn: 0, id: "call-1", name: "execute_sql", isError: false },
  });
  assert.equal(state.currentTurnText, "");
  assert.deepEqual(state.items.at(-1), {
    type: "text",
    turn: 0,
    text: "继续分析",
  });
  state = reduceStreamPresentation(state, {
    event: "text_delta",
    data: { turn: 0, delta: "等待下一轮" },
  });
  assert.equal(state.currentTurnText, "等待下一轮");
  state = reduceStreamPresentation(state, {
    event: "turn_end",
    data: { turn: 0, final: false },
  });

  assert.equal(state.currentTurnText, "");
  assert.deepEqual(state.items, [
    { type: "text", turn: 0, text: "准备查询" },
    {
      type: "tool",
      turn: 0,
      id: "call-1",
      name: "execute_sql",
      arguments: {},
      status: "done",
    },
    { type: "text", turn: 0, text: "继续分析" },
    { type: "text", turn: 0, text: "等待下一轮" },
  ]);
});

test("promotes only the last same-turn text segment and preserves earlier thought items", () => {
  let state = createStreamPresentation();
  state = reduceStreamPresentation(state, { event: "turn_start", data: { turn: 0 } });
  state = reduceStreamPresentation(state, {
    event: "text_delta",
    data: { turn: 0, delta: "先分析" },
  });
  state = reduceStreamPresentation(state, {
    event: "tool_call",
    data: {
      turn: 0,
      id: "call-1",
      name: "execute_sql",
      arguments: { sql: "SELECT 1" },
    },
  });
  state = reduceStreamPresentation(state, {
    event: "text_delta",
    data: { turn: 0, delta: "检查工具结果" },
  });
  state = reduceStreamPresentation(state, {
    event: "tool_end",
    data: { turn: 0, id: "call-1", name: "execute_sql", isError: false },
  });
  state = reduceStreamPresentation(state, {
    event: "text_delta",
    data: { turn: 0, delta: "最终回答" },
  });

  assert.equal(state.finalText, "");
  state = reduceStreamPresentation(state, {
    event: "turn_end",
    data: { turn: 0, final: true },
  });

  assert.equal(state.finalText, "最终回答");
  assert.equal(state.currentTurnText, "");
  assert.deepEqual(state.items, [
    { type: "text", turn: 0, text: "先分析" },
    {
      type: "tool",
      turn: 0,
      id: "call-1",
      name: "execute_sql",
      arguments: { sql: "SELECT 1" },
      status: "done",
    },
    { type: "text", turn: 0, text: "检查工具结果" },
  ]);
});

test("ignores duplicate final turn ends after promoting the answer once", () => {
  let state = createStreamPresentation();
  state = reduceStreamPresentation(state, { event: "turn_start", data: { turn: 0 } });
  state = reduceStreamPresentation(state, {
    event: "text_delta",
    data: { turn: 0, delta: "只提升一次" },
  });
  state = reduceStreamPresentation(state, {
    event: "turn_end",
    data: { turn: 0, final: true },
  });

  const finalized = state;
  state = reduceStreamPresentation(state, {
    event: "turn_end",
    data: { turn: 0, final: true },
  });
  assert.equal(state, finalized);
  assert.equal(state.finalText, "只提升一次");
});

test("settlement and a late error never demote an already finalized answer", () => {
  let state = createStreamPresentation();
  state = reduceStreamPresentation(state, { event: "turn_start", data: { turn: 0 } });
  state = reduceStreamPresentation(state, {
    event: "text_delta",
    data: { turn: 0, delta: "已经完成" },
  });
  state = reduceStreamPresentation(state, {
    event: "turn_end",
    data: { turn: 0, final: true },
  });

  const settled = settleStreamPresentation(state);
  assert.equal(settled.finalized, true);
  assert.equal(settled.finalText, "已经完成");
  assert.equal(settled.settled, true);

  const afterLateError = reduceStreamPresentation(settled, {
    event: "error",
    data: { message: "迟到错误" },
  });
  assert.equal(afterLateError, settled);
});

test("caches generated images across turns without interrupting or replacing the draft", () => {
  const firstImage = {
    id: "ci:call-1:1",
    mimeType: "image/png" as const,
    data: "FIRST",
    alt: "第一张",
  };
  let state = createStreamPresentation();
  state = reduceStreamPresentation(state, { event: "turn_start", data: { turn: 0 } });
  state = reduceStreamPresentation(state, {
    event: "text_delta",
    data: { turn: 0, delta: "正在生成" },
  });
  state = reduceStreamPresentation(state, {
    event: "generated_image",
    data: { turn: 0, toolCallId: "call-1", image: firstImage },
  });
  assert.equal(state.currentTurnText, "正在生成");
  assert.deepEqual(state.images, [firstImage]);

  const firstArrival = state;
  state = reduceStreamPresentation(state, {
    event: "generated_image",
    data: {
      turn: 0,
      toolCallId: "call-1",
      image: { ...firstImage, data: "REPLACEMENT", alt: "重复图片" },
    },
  });
  assert.equal(state, firstArrival);

  state = reduceStreamPresentation(state, {
    event: "turn_end",
    data: { turn: 0, final: false },
  });
  state = reduceStreamPresentation(state, { event: "turn_start", data: { turn: 1 } });
  const secondImage = {
    id: "ci:call-2:1",
    mimeType: "image/png" as const,
    data: "SECOND",
    alt: "第二张",
  };
  state = reduceStreamPresentation(state, {
    event: "generated_image",
    data: { turn: 1, toolCallId: "call-2", image: secondImage },
  });
  assert.deepEqual(state.images, [firstImage, secondImage]);
});

test("tracks threshold compaction before the first turn without changing content", () => {
  const initial = createStreamPresentation();
  const compacting = reduceStreamPresentation(initial, {
    event: "compaction_start",
    data: { reason: "threshold" },
  });

  assert.equal(compacting.compactingReason, "threshold");
  assert.deepEqual(compacting.items, initial.items);
  assert.equal(compacting.finalText, "");
  assert.equal(compacting.finalized, false);

  const completed = reduceStreamPresentation(compacting, {
    event: "compaction_end",
    data: { reason: "threshold", outcome: "completed" },
  });
  assert.equal(completed.compactingReason, null);
  assert.equal(completed.failed, false);
});

test("preserves a finalized answer while post-answer threshold compaction runs", () => {
  let state = createStreamPresentation();
  state = reduceStreamPresentation(state, { event: "turn_start", data: { turn: 0 } });
  state = reduceStreamPresentation(state, {
    event: "text_delta",
    data: { turn: 0, delta: "最终回答" },
  });
  state = reduceStreamPresentation(state, { event: "turn_end", data: { turn: 0, final: true } });
  state = reduceStreamPresentation(state, {
    event: "compaction_start",
    data: { reason: "threshold" },
  });

  assert.equal(state.finalText, "最终回答");
  assert.equal(state.finalized, true);
  assert.equal(state.compactingReason, "threshold");

  state = reduceStreamPresentation(state, {
    event: "compaction_end",
    data: { reason: "threshold", outcome: "aborted" },
  });
  assert.equal(state.finalText, "最终回答");
  assert.equal(state.finalized, true);
  assert.equal(state.compactingReason, null);
});

test("clears overflow compaction before continuing with a new turn", () => {
  let state = createStreamPresentation();
  state = reduceStreamPresentation(state, { event: "turn_start", data: { turn: 0 } });
  state = reduceStreamPresentation(state, {
    event: "text_delta",
    data: { turn: 0, delta: "上下文过长" },
  });
  state = reduceStreamPresentation(state, { event: "turn_end", data: { turn: 0, final: false } });
  state = reduceStreamPresentation(state, {
    event: "compaction_start",
    data: { reason: "overflow" },
  });
  state = reduceStreamPresentation(state, {
    event: "compaction_end",
    data: { reason: "overflow", outcome: "completed" },
  });
  state = reduceStreamPresentation(state, { event: "turn_start", data: { turn: 1 } });

  assert.equal(state.compactingReason, null);
  assert.equal(state.activeTurn, 1);
  assert.equal(state.waiting, true);
  assert.deepEqual(state.items, [{ type: "text", turn: 0, text: "上下文过长" }]);
});

test("ignores unmatched and duplicate compaction end events", () => {
  const initial = createStreamPresentation();
  const unmatched = reduceStreamPresentation(initial, {
    event: "compaction_end",
    data: { reason: "threshold", outcome: "failed" },
  });
  assert.equal(unmatched, initial);

  const compacting = reduceStreamPresentation(initial, {
    event: "compaction_start",
    data: { reason: "overflow" },
  });
  const wrongReason = reduceStreamPresentation(compacting, {
    event: "compaction_end",
    data: { reason: "threshold", outcome: "completed" },
  });
  assert.equal(wrongReason, compacting);

  const completed = reduceStreamPresentation(compacting, {
    event: "compaction_end",
    data: { reason: "overflow", outcome: "completed" },
  });
  const duplicate = reduceStreamPresentation(completed, {
    event: "compaction_end",
    data: { reason: "overflow", outcome: "completed" },
  });
  assert.equal(duplicate, completed);
});

test("clears failed compaction without marking the answer stream as failed", () => {
  let state = createStreamPresentation();
  state = reduceStreamPresentation(state, {
    event: "compaction_start",
    data: { reason: "threshold" },
  });
  state = reduceStreamPresentation(state, {
    event: "compaction_end",
    data: { reason: "threshold", outcome: "failed" },
  });

  assert.equal(state.compactingReason, null);
  assert.equal(state.failed, false);
});

test("clears compaction state on stream errors and settlement", () => {
  const compacting = reduceStreamPresentation(createStreamPresentation(), {
    event: "compaction_start",
    data: { reason: "overflow" },
  });
  const errored = reduceStreamPresentation(compacting, {
    event: "error",
    data: { message: "回答失败" },
  });
  assert.equal(errored.compactingReason, null);
  assert.equal(errored.failed, true);

  const settled = settleStreamPresentation(compacting);
  assert.equal(settled.compactingReason, null);
  assert.equal(settled.failed, false);
  assert.equal(settled.settled, true);
});

test("settlement preserves a partial live draft and never promotes it on a late final event", () => {
  const image = {
    id: "ci:call-1:1",
    mimeType: "image/png" as const,
    data: "IMAGE",
    alt: "部分结果",
  };
  let state = createStreamPresentation();
  state = reduceStreamPresentation(state, { event: "turn_start", data: { turn: 0 } });
  state = reduceStreamPresentation(state, {
    event: "text_delta",
    data: { turn: 0, delta: "未完成正文" },
  });
  state = reduceStreamPresentation(state, {
    event: "generated_image",
    data: { turn: 0, toolCallId: "call-1", image },
  });

  const settled = settleStreamPresentation(state);
  assert.equal(settled.activeTurn, null);
  assert.equal(settled.waiting, false);
  assert.equal(settled.settled, true);
  assert.equal(settled.finalized, false);
  assert.equal(settled.finalText, "");
  assert.equal(settled.currentTurnText, "未完成正文");
  assert.deepEqual(settled.images, [image]);

  const afterLateFinal = reduceStreamPresentation(settled, {
    event: "turn_end",
    data: { turn: 0, final: true },
  });
  assert.equal(afterLateFinal, settled);
  assert.equal(afterLateFinal.finalText, "");
  assert.equal(afterLateFinal.currentTurnText, "未完成正文");
});

test("a settled presentation ignores late events instead of starting a new answer", () => {
  const settled = settleStreamPresentation(createStreamPresentation());
  let next = reduceStreamPresentation(settled, {
    event: "turn_start",
    data: { turn: 1 },
  });
  next = reduceStreamPresentation(next, {
    event: "text_delta",
    data: { turn: 1, delta: "迟到正文" },
  });

  assert.equal(next, settled);
});

test("ignores events whose turn does not match the active turn", () => {
  let state = createStreamPresentation();
  state = reduceStreamPresentation(state, { event: "turn_start", data: { turn: 1 } });
  state = reduceStreamPresentation(state, {
    event: "text_delta",
    data: { turn: 1, delta: "当前草稿" },
  });
  const active = state;

  state = reduceStreamPresentation(state, {
    event: "text_delta",
    data: { turn: 0, delta: "迟到文本" },
  });
  state = reduceStreamPresentation(state, {
    event: "tool_start",
    data: { turn: 0, id: "late-tool", name: "execute_sql" },
  });
  state = reduceStreamPresentation(state, {
    event: "generated_image",
    data: {
      turn: 0,
      toolCallId: "late-tool",
      image: {
        id: "ci:late-tool:1",
        mimeType: "image/png",
        data: "LATE",
        alt: "迟到图片",
      },
    },
  });
  state = reduceStreamPresentation(state, {
    event: "turn_end",
    data: { turn: 0, final: true },
  });

  assert.equal(state, active);
  assert.equal(state.finalText, "");
  assert.equal(state.currentTurnText, "当前草稿");
});
