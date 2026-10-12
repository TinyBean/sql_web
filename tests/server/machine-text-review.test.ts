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
  assert.equal(reviewMachineText("MT 2026-02-01 至 2026-02-03 Conversion 损失集中。", [ranking()]).requiresReview, true);
  assert.equal(reviewMachineText("MT Conversion 损失按机台天口径集中。", [ranking()]).requiresReview, true);
});

function archivedMessage(overrides: Record<string, unknown> = {}, eventOverrides: Record<string, unknown> = {}) {
  return { role: "toolResult", toolName: "read", isError: false,
    details: { source: "data", dataRoot: "/project/.data", path: "/project/.data/daily-analysis/run-1/events.jsonl",
      byteOffset: 0, jsonPointer: "", recordLine: 4, truncated: false, ...overrides },
    content: [{ type: "text", text: JSON.stringify({ type: "tool_result", name: "test_oee_calculator__rank_machines",
      isError: false, result: { details: { ...ranking(), truncated: false } }, ...eventOverrides }) }] };
}

test("complete archived successful rankings authorize only historical explanations in this question", async () => {
  const { emit, user, assistant, sent } = await extensionFixture();
  user("解释今天看板的改善建议来源");
  emit("message_end", { message: archivedMessage() });
  const result = assistant("MT 2026-01-01 至 2026-01-03 Conversion 损失集中。")!;
  assert.ok(result.message.content.some((part) => part.text?.includes(ranking().summary)));
  emit("turn_end");
  assert.equal(sent.length, 0);
  user("解释明天看板的改善建议来源");
  assistant("MT Conversion 损失集中。");
  emit("turn_end");
  assert.equal(sent.length, 1);
});

test("failed, truncated, partial, outside and malformed archived records do not authorize rankings", async () => {
  const cases = [
    archivedMessage({ truncated: true }), archivedMessage({ byteOffset: 10 }),
    archivedMessage({ jsonPointer: "/result/details" }), archivedMessage({ source: "skill" }),
    archivedMessage({ path: "/project/.data/sessions/events.jsonl" }),
    archivedMessage({ path: "/project/outside/daily-analysis/run-1/events.jsonl" }),
    archivedMessage({}, { isError: true }), archivedMessage({}, { name: "execute_sql" }),
    archivedMessage({}, { type: "assistant" }),
    archivedMessage({}, { result: { details: { ...ranking(), truncated: true } } }),
    archivedMessage({}, { result: { details: { ...ranking(), scope: { kind: "MT" }, truncated: false } } }),
    archivedMessage({}, { result: { details: { ...ranking(), range: { start: "2026-02-01", end: "2026-02-03" }, truncated: false } } }),
  ];
  for (const message of cases) {
    const { emit, user, assistant, sent } = await extensionFixture();
    user("解释今天看板的损失来源");
    emit("message_end", { message });
    assistant("MT Conversion 损失集中。"); emit("turn_end");
    assert.equal(sent.length, 1, JSON.stringify(message.details));
  }
});

test("requests for new analysis cannot use archived read results to authorize claims", async () => {
  for (const request of ["重新分析今天看板", "使用最新数据解释今天看板", "分析 Conversion 损失"]) {
    const { emit, user, assistant, sent } = await extensionFixture();
    user(request); emit("message_end", { message: archivedMessage() });
    assistant("MT Conversion 损失集中。"); emit("turn_end");
    assert.equal(sent.length, 1);
  }
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
