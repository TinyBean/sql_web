import assert from "node:assert/strict";
import test from "node:test";
import { buildTypeOverviews } from "../../src/server/dashboard/default/overviews.ts";

const range = { start: "2026-01-01", end: "2026-01-02" };

test("four half-width overviews use independent Test and Effective OEE samples", () => {
  const cards = buildTypeOverviews([
    { day: range.start, kind: "MT", availability_rows: 1, dut_rows: 1, daily_test_oee: .2, daily_effective_oee: .28,
      availability: .5, effective_availability: .7, dut_on: .8, test_time_performance: 1, final_yield: .5 },
    // The effective denominator is zero on this day; Test OEE remains calculable.
    { day: range.end, kind: "MT", availability_rows: 1, dut_rows: 1, daily_test_oee: .9, daily_effective_oee: null,
      availability: 1, effective_availability: null, dut_on: 1, test_time_performance: 1, final_yield: .9 },
    { day: range.start, kind: "ST", availability_rows: 1, dut_rows: 1, daily_test_oee: .1, daily_effective_oee: .3,
      availability: .2, effective_availability: .6, dut_on: 1, test_time_performance: 1, final_yield: .5 },
    { day: range.end, kind: "ST", availability_rows: 1, dut_rows: 0, daily_test_oee: null, daily_effective_oee: null,
      availability: .8, effective_availability: 1, dut_on: null, test_time_performance: null, final_yield: null },
  ], range, ["同步警告"]);
  assert.deepEqual(cards.map((card) => [card.id, card.size, card.encoding.label]), [
    ["mt-effective-oee-overview", "medium", "Effective OEE"], ["mt-oee-overview", "medium", "Test OEE"],
    ["st-effective-oee-overview", "medium", "Effective OEE"], ["st-oee-overview", "medium", "Test OEE"],
  ]);
  const [effective, original, stEffective] = cards;
  assert.ok(Math.abs(Number(effective!.data[0]!["overall_effective_oee_percent"]) - 28) < 1e-10);
  assert.deepEqual(effective!.encoding.gauges.map((gauge) => effective!.data[0]![gauge.column]), [70, 80, 100, 50]);
  assert.deepEqual(original!.encoding.gauges.map((gauge) => original!.data[0]![gauge.column]), [75, 90, 100, 70]);
  assert.ok(Math.abs(Number(original!.data[0]!["overall_oee_percent"]) - 55) < 1e-10);
  assert.equal(stEffective!.data[0]!["overall_effective_oee_percent"], 30);
  assert.match(effective!.encoding.description!, /1\/2/u);
  assert.match(original!.encoding.description!, /2\/2/u);
  assert.ok(effective!.warnings.some((warning) => warning.includes("MT Effective OEE 尚未可计算")));
  assert.deepEqual(original!.warnings, ["同步警告"]);
  assert.ok(stEffective!.warnings.some((warning) => warning.includes("缺 DUT 1 天")));
});

test("effective overviews preserve zero, negative and above-100 values without filling missing types", () => {
  for (const value of [0, -1.25, 1.5]) {
    const cards = buildTypeOverviews([
      { day: range.end, kind: "MT", availability_rows: 1, dut_rows: 1, daily_effective_oee: value,
        effective_availability: value, dut_on: 1, test_time_performance: 1, final_yield: 1 },
    ], range);
    assert.equal(cards[0]!.data[0]!["overall_effective_oee_percent"], value * 100);
    assert.equal(cards[0]!.data[0]!["avg_effective_availability_percent"], value * 100);
    assert.ok(Object.values(cards[2]!.data[0]!).every((metric) => metric === null));
  }
});

test("MT and ST overviews keep independent daily means, components, and coverage", () => {
  const cards = buildTypeOverviews([
    { day: range.start, kind: "MT", availability_rows: 1, dut_rows: 1, daily_test_oee: .16, availability: .2, performance: .8, dut_on: .8, test_time_performance: 1, final_yield: 1 },
    { day: range.end, kind: "MT", availability_rows: 1, dut_rows: 1, daily_test_oee: .2, availability: .8, performance: .5, dut_on: .5, test_time_performance: 1, final_yield: .5 },
    { day: range.start, kind: "ST", availability_rows: 1, dut_rows: 1, daily_test_oee: .729, availability: .9, performance: .9, dut_on: .9, test_time_performance: 1, final_yield: .9 },
    { day: range.end, kind: "ST", availability_rows: 1, dut_rows: 0, daily_test_oee: null, availability: .1, performance: null, dut_on: null, test_time_performance: null, final_yield: null },
  ], range, ["同步警告"]).filter((card) => card.encoding.label === "Test OEE");
  assert.deepEqual(cards.map((card) => [card.id, card.kind, card.size]), [
    ["mt-oee-overview", "overview", "medium"], ["st-oee-overview", "overview", "medium"],
  ]);
  assert.deepEqual(cards[0]!.data, [{
    overall_oee_percent: 18, avg_availability_percent: 50, avg_performance_percent: 65, avg_dut_on_percent: 65, avg_test_time_percent: 100, avg_yield_percent: 75,
  }]);
  assert.ok(Math.abs(Number(cards[1]!.data[0]?.["overall_oee_percent"]) - 72.9) < 1e-10);
  assert.deepEqual(cards[1]!.encoding.gauges.map((gauge) => cards[1]!.data[0]?.[gauge.column]), [90, 90, 100, 90]);
  for (const card of cards) {
    assert.equal(card.encoding.label, "Test OEE");
    assert.deepEqual(card.encoding.gauges.map((gauge) => gauge.name), ["Availability", "Performance (DUT-On)", "Performance (Test Time)", "Yield"]);
    assert.ok(card.warnings.includes("同步警告"));
    assert.ok(card.encoding.gauges.every((gauge) => typeof card.data[0]?.[gauge.column] === "number"));
  }
  assert.match(cards[0]!.encoding.description!, /MT.*2\/2/u);
  assert.match(cards[1]!.encoding.description!, /ST.*1\/2/u);
  assert.deepEqual(cards[0]!.warnings, ["同步警告"]);
  assert.ok(cards[1]!.warnings.some((warning) => warning.includes("缺 DUT 1 天")));
  assert.ok(cards[1]!.warnings.some((warning) => warning.includes("2026-01-02 的 ST")));
});

test("zero OEE stays zero and a missing type never borrows the other type's metrics", () => {
  const cards = buildTypeOverviews([
    { day: range.end, kind: "MT", availability_rows: 1, dut_rows: 1, daily_test_oee: 0, availability: 0, performance: 1, dut_on: 1, test_time_performance: 1, final_yield: 1 },
  ], range).filter((card) => card.encoding.label === "Test OEE");
  assert.deepEqual(cards[0]!.data, [{
    overall_oee_percent: 0, avg_availability_percent: 0, avg_performance_percent: 100, avg_dut_on_percent: 100, avg_test_time_percent: 100, avg_yield_percent: 100,
  }]);
  assert.deepEqual(Object.values(cards[1]!.data[0]!), [null, null, null, null, null, null]);
  const empty = buildTypeOverviews([], range).filter((card) => card.encoding.label === "Test OEE");
  assert.ok(empty.every((card) => Object.values(card.data[0]!).every((value) => value === null)));
});
