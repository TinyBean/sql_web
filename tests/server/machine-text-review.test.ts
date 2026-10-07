import assert from "node:assert/strict";
import test from "node:test";
import { createMachineTextReviewExtension, reviewMachineText, MACHINE_TEXT_REVIEW_MESSAGE_TYPE,
  type RankingNarrative } from "../../src/server/agent/machine-text-review.ts";
import { machineRankingView } from "../../src/server/skills/test-oee-calculator/assets/machine-ranking.ts";

function ranking(kind: "MT" | "ST" = "MT"): RankingNarrative {
  const scope = { kind, metric: "loss_hours" as const, states: ["Conversion"], basis: "report_period" as const, platformVersion: "oee-v4" };
  const range = { start: "2026-01-01", end: "2026-01-03" };
  return { range, scope, ...machineRankingView({ range, scope, rows: [
    { machine: "ADH001", platform: "T5773", machine_label: "T5773/ADH001", metric_value: 10, availability_days: 2, selected_days: 3 },
  ] }) };
}

test("chat adds deterministic TOP3, corrects platform labels, and preserves the exact server summary", () => {
  const evidence = ranking();
  const result = reviewMachineText("MT Conversion 损失集中于 ADH001，原因待验证。", [evidence], "分析本周换线损失");
  assert.equal(result.requiresReview, false);
  assert.match(result.text, /集中于 T5773\/ADH001/u);
  assert.ok(result.text.includes(evidence.summary));
  assert.deepEqual(reviewMachineText(result.text, [evidence], "分析本周换线损失"), result);
});

test("formula explanations and single-machine value queries only add platform labels", () => {
  assert.deepEqual(reviewMachineText("ADH001 的 OEE 为 50%。", [], "查询 ADH001 的 OEE"), {
    text: "T5773/ADH001 的 OEE 为 50%。", requiresReview: false,
  });
  assert.equal(reviewMachineText("可用率下降会导致 OEE 下降。", [], "OEE 公式怎么算").requiresReview, false);
  assert.equal(reviewMachineText("ADH161 平台尚未维护。", [], "查询 ADH161 平台").text, "平台待维护/ADH161 平台尚未维护。");
});

test("unsupported distribution, unverified TOP3, wrong metric/type/state and extra fabricated rankings need repair", () => {
  assert.equal(reviewMachineText("损失集中在少数机台。", []).requiresReview, true);
  assert.equal(reviewMachineText("TOP3：ADH001 999 小时。", [ranking()]).requiresReview, true);
  assert.equal(reviewMachineText("ST 损失集中于少数机台。", [ranking()]).requiresReview, true);
  assert.equal(reviewMachineText("MT Socket 使用率偏低。", [ranking()]).requiresReview, true);
  assert.equal(reviewMachineText("MT PM 损失集中于少数机台。", [ranking()]).requiresReview, true);
  assert.equal(reviewMachineText(ranking().summary + "\nTOP3：ADH002 999 小时。", [ranking()]).requiresReview, true);
  assert.equal(reviewMachineText("机台数据不足，无法生成 TOP3。", []).requiresReview, false);
  assert.equal(reviewMachineText("机台数据不足，但损失集中在少数机台。", []).requiresReview, true);
  assert.equal(reviewMachineText("问题集中于 ADH001。", [], "查询 ADH001 的 OEE").requiresReview, true);
});

async function extensionFixture() {
  const handlers = new Map<string, (...args: never[]) => unknown>();
  const sent: { customType: string; content: string; display: boolean }[] = [];
  const extension = createMachineTextReviewExtension({ info() {}, warn() {} });
  const factory = typeof extension === "function" ? extension : extension.factory;
  await factory({ on: (name: string, handler: (...args: never[]) => unknown) => handlers.set(name, handler),
    sendMessage: (message: typeof sent[number]) => sent.push(message) } as never);
  const context = { sessionManager: { getSessionId: () => "test-session" } };
  const emit = (name: string, value: unknown = {}) => handlers.get(name)?.(value as never, context as never);
  const user = (text = "分析损失原因") => emit("message_end", { message: { role: "user", content: [{ type: "text", text }] } });
  const assistant = (text: string) => emit("message_end", { message: { role: "assistant", stopReason: "stop",
    content: [{ type: "thinking", thinking: "trace" }, { type: "text", text }] } }) as { message: { content: { text?: string }[] } } | undefined;
  return { sent, emit, user, assistant };
}

test("the chat extension performs at most one repair, bounds ranking calls, blocks actions and falls back honestly", async () => {
  const { sent, emit, user, assistant } = await extensionFixture();
  user(); assistant("损失集中在少数机台。"); emit("turn_end");
  assert.equal(sent.length, 1); assert.equal(sent[0]!.customType, MACHINE_TEXT_REVIEW_MESSAGE_TYPE);
  for (let i = 0; i < 6; i++) assert.equal(emit("tool_call", { toolName: "test_oee_calculator__rank_machines" }), undefined);
  assert.ok(emit("tool_call", { toolName: "test_oee_calculator__rank_machines" }));
  assert.ok(emit("tool_call", { toolName: "send_email" }));
  assert.ok(emit("tool_call", { toolName: "update_dashboard" }));
  const fallback = assistant("仍集中在少数机台。"); emit("turn_end");
  assert.match(fallback!.message.content.map((part) => part.text ?? "").join(""), /机台分布证据不足/u);
  assert.equal(sent.length, 1);
});

test("only successful current-question ranking results authorize summaries; a new question resets evidence", async () => {
  const { emit, user, assistant } = await extensionFixture();
  user();
  emit("message_end", { message: { role: "toolResult", toolName: "test_oee_calculator__rank_machines", isError: false,
    details: { ...ranking(), truncated: false } } });
  const result = assistant("MT Conversion 损失集中。")!;
  assert.ok(result.message.content.some((part) => part.text?.includes(ranking().summary)));
  user("分析 ST 损失原因");
  emit("message_end", { message: { role: "toolResult", toolName: "test_oee_calculator__rank_machines", isError: true,
    details: { ...ranking("ST"), truncated: false } } });
  assert.equal(assistant("ST 损失集中于少数机台。"), undefined);
});
