/// <reference lib="dom" />

import assert from "node:assert/strict";
import test from "node:test";
import { parseHTML } from "linkedom";
import * as marked from "marked";
import { renderMarkdownInto } from "../../src/client/markdown.ts";

interface TestMarkdownGlobals {
  marked?: typeof marked;
  DOMPurify?: { sanitize(dirty: string): string };
}

const markdownGlobals = globalThis as typeof globalThis & TestMarkdownGlobals;
const originalMarked = markdownGlobals.marked;
const originalDomPurify = markdownGlobals.DOMPurify;

test.before(() => {
  markdownGlobals.marked = marked;
  markdownGlobals.DOMPurify = { sanitize: (dirty) => dirty };
});

test.after(() => {
  if (originalMarked) markdownGlobals.marked = originalMarked;
  else delete markdownGlobals.marked;
  if (originalDomPurify) markdownGlobals.DOMPurify = originalDomPurify;
  else delete markdownGlobals.DOMPurify;
});

function container(): HTMLElement {
  const { document } = parseHTML("<html><body></body></html>");
  return document.createElement("div") as unknown as HTMLElement;
}

test("requires double tildes for strikethrough", () => {
  const root = container();

  renderMarkdownInto(
    root,
    "离散度为 5.52%~33.35%，运行秒数为 3.3~4.5 万秒；~~旧口径~~。",
  );

  assert.equal(root.textContent, "离散度为 5.52%~33.35%，运行秒数为 3.3~4.5 万秒；旧口径。\n");
  assert.equal(root.querySelectorAll("del").length, 1);
  assert.equal(root.querySelector("del")?.textContent, "旧口径");
});

test("renders image descriptions as text without creating image nodes", () => {
  const root = container();
  renderMarkdownInto(root, [
    "![旧图](/__datalens_generated_image__/ci-legacy)",
    "![外链](https://example.com/chart.png)",
    "![内联](data:image/png;base64,AAAA)",
    "![<script>alert(1)</script>](sandbox:/work/chart.png)",
    '<img src="https://example.com/raw.png" onerror="alert(1)">',
    "[普通链接](https://example.com)",
  ].join("\n\n"));
  assert.equal(root.querySelectorAll("img, script").length, 0);
  assert.match(root.textContent ?? "", /旧图/u);
  assert.match(root.textContent ?? "", /<script>alert\(1\)<\/script>/u);
  assert.equal(root.querySelector("a")?.getAttribute("rel"), "noopener noreferrer");
  assert.doesNotMatch(root.innerHTML, /markdown-image-reference|data-generated-image-id/u);
});

test("preserves Markdown image syntax in code blocks and uses inert text on parser failure", () => {
  const root = container();
  const syntax = "![旧图](/__datalens_generated_image__/ci-legacy)";
  renderMarkdownInto(root, "```markdown\n" + syntax + "\n```");
  assert.equal(root.querySelector("code")?.textContent, syntax + "\n");
  assert.equal(root.querySelectorAll("img").length, 0);
  const purifier = markdownGlobals.DOMPurify;
  delete markdownGlobals.DOMPurify;
  try {
    renderMarkdownInto(root, '<img src="https://example.com">');
    assert.equal(root.querySelectorAll("img").length, 0);
    assert.equal(root.textContent, '<img src="https://example.com">');
  } finally {
    if (purifier) markdownGlobals.DOMPurify = purifier;
  }
});
