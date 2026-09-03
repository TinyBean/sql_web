import assert from "node:assert/strict";
import test from "node:test";
import { isRuntimeImagePlaceholder } from "../../src/client/image-placeholders.ts";

test("recognizes interpreter-only image placeholders without replacing real URLs", () => {
  assert.equal(isRuntimeImagePlaceholder("artifact://image.png"), true);
  assert.equal(isRuntimeImagePlaceholder("sandbox:/mnt/data/chart.png"), true);
  assert.equal(isRuntimeImagePlaceholder("/work/chart.png"), true);
  assert.equal(isRuntimeImagePlaceholder(null), true);
  assert.equal(isRuntimeImagePlaceholder("https://example.com/chart.png"), false);
  assert.equal(isRuntimeImagePlaceholder("data:image/png;base64,AAAA"), false);
});
