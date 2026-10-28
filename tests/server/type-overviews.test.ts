import assert from "node:assert/strict";
import test from "node:test";
import { buildTypeOverviews } from "../../src/server/dashboard/default/calculate/index.ts";
import type { DashboardRow } from "../../src/shared/dashboard.ts";

const range = { start: "2026-01-01", end: "2026-01-02" };
function row(kind: string, values: DashboardRow = {}): DashboardRow {
  return { kind, selected_day_count: 2, calculable_day_type_count: 2, effective_calculable_day_type_count: 2,
    availability_day_type_count: 2, dut_day_type_count: 2, ...values };
}

test("four half-width overviews use pooled components even when daily Effective OEE coverage is smaller", () => {
  const cards = buildTypeOverviews([
    row("MT", { test_oee: .4725, effective_oee: .6265, availability: .75, effective_availability: 1,
      dut_on: .9, test_time_performance: 1, final_yield: .7, effective_calculable_day_type_count: 1 }),
    row("ST", { test_oee: .25, effective_oee: .358, availability: .5, effective_availability: .8,
      dut_on: 1, test_time_performance: 1, final_yield: .5,
      calculable_day_type_count: 1, effective_calculable_day_type_count: 1, dut_day_type_count: 1 }),
  ], range, ["同步警告"], [
    { kind: "MT", test_oee: .9, effective_oee: null }, { kind: "ST", test_oee: null, effective_oee: null },
  ]);
  assert.deepEqual(cards.map((card) => [card.id, card.size, card.encoding.label]), [
    ["mt-effective-oee-overview", "medium", "Effective OEE"], ["mt-oee-overview", "medium", "Test OEE"],
    ["st-effective-oee-overview", "medium", "Effective OEE"], ["st-oee-overview", "medium", "Test OEE"],
  ]);
  const [effective, original, stEffective] = cards;
  assert.ok(Math.abs(Number(effective!.data[0]!["overall_effective_oee_percent"]) - 62.65) < 1e-10);
  assert.deepEqual(effective!.encoding.gauges.map((gauge) => effective!.data[0]![gauge.column]), [100, 89.5, 100, 70]);
  assert.deepEqual(original!.encoding.gauges.map((gauge) => original!.data[0]![gauge.column]), [75, 90, 100, 70]);
  assert.equal(original!.data[0]!["overall_oee_percent"], 47.25);
  assert.ok(Math.abs(Number(stEffective!.data[0]!["overall_effective_oee_percent"]) - 35.8) < 1e-10);
  assert.match(effective!.encoding.description!, /1\/2/u); assert.match(original!.encoding.description!, /2\/2/u);
  assert.ok(effective!.warnings.some((warning) => warning.includes("MT Effective OEE 尚未可计算")));
  assert.deepEqual(original!.warnings, ["同步警告"]);
  assert.ok(stEffective!.warnings.some((warning) => warning.includes("缺 DUT 1 天")));
});

test("effective overviews preserve zero, negative and above-100 pooled values without filling missing types", () => {
  for (const value of [0, -1.25, 1.5]) {
    const cards = buildTypeOverviews([
      row("MT", { effective_oee: value, effective_availability: value, dut_on: 1, test_time_performance: 1, final_yield: 1 }),
    ], range);
    assert.equal(cards[0]!.data[0]!["overall_effective_oee_percent"], value * 100);
    assert.equal(cards[0]!.data[0]!["avg_effective_availability_percent"], value * 100);
    assert.ok(Object.entries(cards[2]!.data[0]!).every(([key, metric]) => metric === (key === "avg_effective_dut_on_percent" ? 89.5 : null)));
  }
});

test("MT and ST project their own pooled metrics and independent coverage", () => {
  const cards = buildTypeOverviews([
    row("MT", { test_oee: .24375, availability: .5, dut_on: .65, test_time_performance: 1, final_yield: .75 }),
    row("ST", { test_oee: .405, availability: .5, dut_on: .9, test_time_performance: 1, final_yield: .9,
      calculable_day_type_count: 1, dut_day_type_count: 1 }),
  ], range, ["同步警告"], [{ kind: "MT", test_oee: .2 }, { kind: "ST", test_oee: null }])
    .filter((card) => card.encoding.label === "Test OEE");
  assert.deepEqual(cards.map((card) => [card.id, card.kind, card.size]), [
    ["mt-oee-overview", "overview", "medium"], ["st-oee-overview", "overview", "medium"],
  ]);
  assert.deepEqual(cards[0]!.data, [{
    overall_oee_percent: 24.375, avg_availability_percent: 50, avg_performance_percent: 65,
    avg_dut_on_percent: 65, avg_test_time_percent: 100, avg_yield_percent: 75,
  }]);
  assert.equal(cards[1]!.data[0]!["overall_oee_percent"], 40.5);
  assert.deepEqual(cards[1]!.encoding.gauges.map((gauge) => cards[1]!.data[0]?.[gauge.column]), [50, 90, 100, 90]);
  for (const card of cards) {
    assert.deepEqual(card.encoding.gauges.map((gauge) => gauge.name), ["Availability", "Performance (DUT-On)", "Performance (Test Time)", "Yield"]);
    assert.ok(card.warnings.includes("同步警告"));
  }
  assert.match(cards[0]!.encoding.description!, /MT.*2\/2/u); assert.match(cards[1]!.encoding.description!, /ST.*1\/2/u);
  assert.deepEqual(cards[0]!.warnings, ["同步警告"]);
  assert.ok(cards[1]!.warnings.some((warning) => warning.includes("缺 DUT 1 天")));
  assert.ok(cards[1]!.warnings.some((warning) => warning.includes("2026-01-02 的 ST")));
});

test("zero OEE stays zero and an absent type never borrows another type's pooled metrics", () => {
  const cards = buildTypeOverviews([
    row("MT", { test_oee: 0, availability: 0, dut_on: 1, test_time_performance: 1, final_yield: 1 }),
  ], range).filter((card) => card.encoding.label === "Test OEE");
  assert.deepEqual(cards[0]!.data, [{
    overall_oee_percent: 0, avg_availability_percent: 0, avg_performance_percent: 100,
    avg_dut_on_percent: 100, avg_test_time_percent: 100, avg_yield_percent: 100,
  }]);
  assert.deepEqual(Object.values(cards[1]!.data[0]!), [null, null, null, null, null, null]);
  assert.ok(buildTypeOverviews([], range).every((card) => Object.entries(card.data[0]!).every(([key, value]) => value === (key === "avg_effective_dut_on_percent" ? 89.5 : null))));
});
