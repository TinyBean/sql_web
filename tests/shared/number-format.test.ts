import assert from "node:assert/strict";
import test from "node:test";
import { formatDisplayNumber } from "../../src/shared/number-format.ts";

test("display rounding preserves integers and pads fractional values using halfExpand", () => {
  const cases: readonly (readonly [number, string])[] = [
    [12, "12"], [0, "0"], [-12, "-12"], [-0, "0"],
    [1.2, "1.20"], [1.234, "1.23"], [1.235, "1.24"], [1.999, "2.00"],
    [1.005, "1.01"], [2.675, "2.68"], [-1.005, "-1.01"], [-1.235, "-1.24"],
    [0.004, "0.00"], [-0.004, "0.00"], [0.005, "0.01"], [-0.005, "-0.01"],
    [1e-7, "0.00"], [12345.678, "12345.68"],
  ];
  for (const [value, expected] of cases) assert.equal(formatDisplayNumber(value), expected, String(value));
});
