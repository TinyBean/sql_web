import assert from "node:assert/strict";
import test from "node:test";
import { buildTypeOverviews } from "../../src/server/dashboard/default/overviews.ts";

const range = { start: "2026-01-01", end: "2026-01-02" };

test("MT and ST overviews keep independent daily means, components, and coverage", () => {
  const cards = buildTypeOverviews([
    { day: range.start, kind: "MT", availability_rows: 1, dut_rows: 1, daily_test_oee: .16, availability: .2, performance: .8, dut_on: .8, test_time_performance: 1, final_yield: 1 },
    { day: range.end, kind: "MT", availability_rows: 1, dut_rows: 1, daily_test_oee: .2, availability: .8, performance: .5, dut_on: .5, test_time_performance: 1, final_yield: .5 },
    { day: range.start, kind: "ST", availability_rows: 1, dut_rows: 1, daily_test_oee: .729, availability: .9, performance: .9, dut_on: .9, test_time_performance: 1, final_yield: .9 },
    { day: range.end, kind: "ST", availability_rows: 1, dut_rows: 0, daily_test_oee: null, availability: .1, performance: null, dut_on: null, test_time_performance: null, final_yield: null },
  ], range, ["同步警告"]);
  assert.deepEqual(cards.map((card) => [card.id, card.kind, card.size]), [
    ["mt-oee-overview", "overview", "wide"], ["st-oee-overview", "overview", "wide"],
  ]);
  assert.deepEqual(cards[0]!.data, [{
    overall_oee_percent: 18, avg_availability_percent: 50, avg_performance_percent: 65, avg_dut_on_percent: 65, avg_test_time_percent: 100, avg_yield_percent: 75,
  }]);
  assert.ok(Math.abs(Number(cards[1]!.data[0]?.["overall_oee_percent"]) - 72.9) < 1e-10);
  assert.deepEqual(cards[1]!.encoding.gauges.map((gauge) => cards[1]!.data[0]?.[gauge.column]), [90, 90, 100, 90]);
  for (const card of cards) {
    assert.equal(card.encoding.label, "Overall OEE");
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
  ], range);
  assert.deepEqual(cards[0]!.data, [{
    overall_oee_percent: 0, avg_availability_percent: 0, avg_performance_percent: 100, avg_dut_on_percent: 100, avg_test_time_percent: 100, avg_yield_percent: 100,
  }]);
  assert.deepEqual(Object.values(cards[1]!.data[0]!), [null, null, null, null, null, null]);
  const empty = buildTypeOverviews([], range);
  assert.ok(empty.every((card) => Object.values(card.data[0]!).every((value) => value === null)));
});
