import assert from "node:assert/strict";
import test from "node:test";
import { createWeeklyImprovementEmail } from "../../src/server/dashboard/default/weekly-email.ts";
import { createAnalysisTemplate } from "../../src/server/dashboard/default/template.ts";
import { weeklyDashboard } from "../helpers/weekly-dashboard.ts";

const weekId = createAnalysisTemplate("week").id;

test("weekly email preserves the six columns and published values, without including monthly or quarterly rows", () => {
  const state = weeklyDashboard();
  const email = createWeeklyImprovementEmail({ ...state, widgets: [...state.widgets].reverse().map((widget) => {
    if (widget.id === weekId) return { ...widget, warnings: [...widget.warnings, "数据缺失：仅反映已有数据"],
      data: widget.data.map((row) => ({ ...row, measure: '检查 <script>bad()</script> & "参数"\n核实原因' })) };
    return { ...widget, data: [{ issue: "不得出现在周表中的月季信息" }] };
  }) }, "2026-09-14");
  assert.equal(email.subject, "周改善措施表（2026-W36） · 截止 2026-09-14");
  for (const body of [email.text, email.html!]) {
    for (const text of ["2026-09-06 至 2026-09-12", "截止业务日：2026-09-14", "MT", "ST", "换线时间偏长",
      "测试时间波动", "2.5", "—", "职能建议，待人工确认", "数据缺失：仅反映已有数据", "统计口径："]) {
      assert.ok(body.includes(text), text);
    }
    assert.doesNotMatch(body, /不得出现在周表中的月季信息/u);
  }
  assert.match(email.text, /类型\t优先级\t问题\(损失源\)\t改善措施\t建议责任人\t本期损失小时/u);
  assert.match(email.text, /<script>bad\(\)<\/script>/u);
  assert.match(email.html!, /&lt;script&gt;bad\(\)&lt;\/script&gt; &amp; &quot;参数&quot;<br>核实原因/u);
  assert.doesNotMatch(email.html!, /<script>/u);
  assert.equal(email.html!.match(/<th>/gu)?.length, 6);
});

test("empty suggestions retain both kinds' explanations and cross-year week boundaries", () => {
  const state = weeklyDashboard("2026-01-04");
  const email = createWeeklyImprovementEmail({ ...state, widgets: state.widgets.map((widget) => widget.id !== weekId ? widget : {
    ...widget, data: [], warnings: [...widget.warnings, "MT 未生成建议：无充分依据", "ST 未生成建议：无可计算指标"],
  }) }, "2026-01-04");
  assert.equal(email.subject, "周改善措施表（2025-W52） · 截止 2026-01-04");
  for (const body of [email.text, email.html!]) {
    assert.match(body, /2025-12-28 至 2026-01-03/u);
    assert.match(body, /本期未生成改善建议/u);
    assert.match(body, /MT 未生成建议：无充分依据/u);
    assert.match(body, /ST 未生成建议：无可计算指标/u);
  }
});

test("missing and unavailable weekly cards cannot become a notification", () => {
  const state = weeklyDashboard();
  for (const widgets of [state.widgets.filter((widget) => widget.id !== weekId),
    state.widgets.map((widget) => widget.id !== weekId ? widget : { ...widget, warnings: ["本次分析暂不可用：超时"] })]) {
    assert.throws(() => createWeeklyImprovementEmail({ ...state, widgets }, "2026-09-14"), /不可用/u);
  }
});
