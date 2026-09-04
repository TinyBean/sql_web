import assert from "node:assert/strict";
import test from "node:test";
import {
  createStreamPresentation,
  formatToolStatusText,
  reduceStreamPresentation,
} from "../../src/client/stream-state.ts";

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

test("preserves text/tool order and promotes only the final turn", () => {
  let state = createStreamPresentation();
  state = reduceStreamPresentation(state, { event: "turn_start", data: { turn: 0 } });
  state = reduceStreamPresentation(state, { event: "text_delta", data: { turn: 0, delta: "先" } });
  state = reduceStreamPresentation(state, { event: "text_delta", data: { turn: 0, delta: "查询" } });
  state = reduceStreamPresentation(state, {
    event: "tool_call",
    data: { turn: 0, id: "call-1", name: "execute_sql" },
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
  assert.deepEqual(state.items, [
    { type: "text", turn: 0, text: "先查询" },
    { type: "tool", turn: 0, id: "call-1", name: "execute_sql", status: "done" },
    { type: "text", turn: 1, text: "最终回答" },
  ]);

  state = reduceStreamPresentation(state, { event: "turn_end", data: { turn: 1, final: true } });
  assert.equal(state.finalText, "最终回答");
  assert.equal(state.finalized, true);
  assert.deepEqual(state.items, [
    { type: "text", turn: 0, text: "先查询" },
    { type: "tool", turn: 0, id: "call-1", name: "execute_sql", status: "done" },
  ]);
});

test("keeps incomplete thought content expanded on errors", () => {
  let state = createStreamPresentation();
  state = reduceStreamPresentation(state, { event: "turn_start", data: { turn: 0 } });
  state = reduceStreamPresentation(state, { event: "text_delta", data: { turn: 0, delta: "处理中" } });
  state = reduceStreamPresentation(state, { event: "error", data: { message: "失败" } });
  assert.equal(state.failed, true);
  assert.equal(state.finalized, false);
  assert.deepEqual(state.items, [{ type: "text", turn: 0, text: "处理中" }]);
});
