import assert from "node:assert/strict";
import test from "node:test";
import { createDailyImprovementEmail } from "../../src/server/dashboard/default/daily-email.ts";
import { createAnalysisTemplate } from "../../src/server/dashboard/default/template.ts";
import { dailyDashboard } from "../helpers/daily-dashboard.ts";

const dayId = createAnalysisTemplate("day").id;

test("daily email preserves the six columns and published values, without including weekly or longer-period rows", () => {
  const state = dailyDashboard();
  const email = createDailyImprovementEmail({ ...state, widgets: [...state.widgets].reverse().map((widget) => {
    if (widget.id === dayId) return { ...widget, warnings: [...widget.warnings, "数据缺失：仅反映已有数据"],
      data: widget.data.map((row) => ({ ...row, measure: '检查 <script>bad()</script> & "参数"\n核实原因' })) };
    return { ...widget, data: [{ issue: "不得出现在日表中的周月季信息" }] };
  }) }, "2026-09-14");
  assert.equal(email.subject, "日改善措施表(2026-09-14) · 截止 2026-09-14");
  for (const body of [email.text, email.html!]) {
    for (const text of ["统计业务日:2026-09-14", "截止业务日:2026-09-14", "MT", "ST", "换线时间偏长",
      "测试等待偏长", "2.50", "1.20", "职能建议，待人工确认", "数据缺失：仅反映已有数据", "统计口径:"]) {
      assert.ok(body.includes(text), text);
    }
    assert.doesNotMatch(body, /不得出现在日表中的周月季信息/u);
  }
  assert.match(email.text, /类型\t优先级\t问题\(损失源\)\t改善措施\t建议责任人\t本期损失小时/u);
  assert.match(email.text, /<script>bad\(\)<\/script>/u);
  assert.match(email.html!, /&lt;script&gt;bad\(\)&lt;\/script&gt; &amp; &quot;参数&quot;<br>核实原因/u);
  assert.doesNotMatch(email.html!, /<script>/u);
  assert.equal(email.html!.match(/<th>/gu)?.length, 6);
});

test("daily email rejects invalid hours and narrative types, and preserves measured zero", () => {
  const state = dailyDashboard();
  for (const [key, value] of [["loss_hours", null], ["loss_hours", undefined], ["loss_hours", NaN], ["loss_hours", Infinity],
    ["loss_hours", "1.2"], ["issue", undefined], ["measure", 1], ["suggested_owner", null]] as const) {
    assert.throws(() => createDailyImprovementEmail({ ...state, widgets: state.widgets.map((widget) => widget.id !== dayId ? widget : {
      ...widget, data: widget.data.map((row) => ({ ...row, [key]: value })),
    }) } as typeof state, "2026-09-14"), /字符串|有限数值/u);
  }
  const email = createDailyImprovementEmail({ ...state, widgets: state.widgets.map((widget) => widget.id !== dayId ? widget : {
    ...widget, data: widget.data.map((row) => ({ ...row, loss_hours: 0 })),
  }) }, "2026-09-14");
  assert.match(email.text, /\t0(?:\n|$)/u);
  assert.doesNotMatch(email.text, /—/u);
});

test("daily email uses the global display rule with legacy precision and retains source values", () => {
  const state = dailyDashboard();
  const values = [1.005, 1.2, 1.999, -1.005, -0.004, 12];
  const expected = ["1.01", "1.20", "2.00", "-1.01", "0.00", "12"];
  const source = { ...state, widgets: state.widgets.map((widget) => widget.id !== dayId ? widget : {
    ...widget, format: { unit: "", precision: 0 },
    data: values.map((loss_hours) => ({ ...widget.data[0], loss_hours })),
  }) };
  const original = structuredClone(source);
  const email = createDailyImprovementEmail(source, "2026-09-14");
  assert.deepEqual(email.text.split("\n").filter((line) => line.startsWith("MT\t")).map((line) => line.split("\t").at(-1)), expected);
  for (const value of expected) assert.ok(email.html!.includes("<td>" + value + "</td>"), value);
  assert.deepEqual(source, original);
});

test("daily email accepts empty, whitespace and unrestricted narrative strings", () => {
  const state = dailyDashboard();
  for (const text of ["", " \t ", "依据 q11 第 0 行 execute_sql loss_hours 判断", "机台损失集中，TOP3 待核查"]) {
    const email = createDailyImprovementEmail({ ...state, widgets: state.widgets.map((widget) => widget.id !== dayId ? widget : {
      ...widget, data: widget.data.map((row) => ({ ...row, issue: text, measure: text, suggested_owner: text })),
    }) }, "2026-09-14");
    assert.ok(email.text.includes(text));
    assert.ok(email.html!.includes(text));
  }
});

test("empty suggestions retain both kinds' explanations", () => {
  const state = dailyDashboard("2026-01-05");
  const email = createDailyImprovementEmail({ ...state, widgets: state.widgets.map((widget) => widget.id !== dayId ? widget : {
    ...widget, data: [], warnings: [...widget.warnings, "MT 未生成建议：无充分依据", "ST 未生成建议：无可计算指标"],
  }) }, "2026-01-05");
  assert.equal(email.subject, "日改善措施表(2026-01-05) · 截止 2026-01-05");
  for (const body of [email.text, email.html!]) {
    assert.match(body, /统计业务日:2026-01-05/u);
    assert.match(body, /本期未生成改善建议/u);
    assert.match(body, /MT 未生成建议：无充分依据/u);
    assert.match(body, /ST 未生成建议：无可计算指标/u);
  }
});

test("missing and unavailable daily cards cannot become a notification", () => {
  const state = dailyDashboard();
  for (const widgets of [state.widgets.filter((widget) => widget.id !== dayId),
    state.widgets.map((widget) => widget.id !== dayId ? widget : { ...widget, warnings: ["本次分析暂不可用：超时"] })]) {
    assert.throws(() => createDailyImprovementEmail({ ...state, widgets }, "2026-09-14"), /不可用/u);
  }
});


test("degraded email marks quality and affected periods while retaining only daily rows", () => {
  const state = dailyDashboard();
  const email = createDailyImprovementEmail(state, "2026-09-14", { status: "degraded", exclusions: [
    { period: "quarter", kind: "MT", priority: 3, codes: ["METRIC_CATEGORY_MISMATCH"] },
  ] });
  assert.match(email.subject, /报告降级/u);
  for (const body of [email.text, email.html!]) {
    assert.match(body, /季度 MT 剔除 1 条/u);
    assert.match(body, /仅展示已通过证据校验的日建议/u);
    assert.match(body, /换线时间偏长/u);
    assert.doesNotMatch(body, /METRIC_CATEGORY_MISMATCH|q35/u);
  }
});
