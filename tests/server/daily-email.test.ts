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
  assert.equal(email.subject, "日改善措施表（2026-09-14） · 截止 2026-09-14");
  for (const body of [email.text, email.html!]) {
    for (const text of ["统计业务日：2026-09-14", "截止业务日：2026-09-14", "MT", "ST", "换线时间偏长",
      "测试时间波动", "2.5", "—", "职能建议，待人工确认", "数据缺失：仅反映已有数据", "统计口径："]) {
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

test("empty suggestions retain both kinds' explanations", () => {
  const state = dailyDashboard("2026-01-05");
  const email = createDailyImprovementEmail({ ...state, widgets: state.widgets.map((widget) => widget.id !== dayId ? widget : {
    ...widget, data: [], warnings: [...widget.warnings, "MT 未生成建议：无充分依据", "ST 未生成建议：无可计算指标"],
  }) }, "2026-01-05");
  assert.equal(email.subject, "日改善措施表（2026-01-05） · 截止 2026-01-05");
  for (const body of [email.text, email.html!]) {
    assert.match(body, /统计业务日：2026-01-05/u);
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
