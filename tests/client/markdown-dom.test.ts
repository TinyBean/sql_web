/// <reference lib="dom" />

import assert from "node:assert/strict";
import test from "node:test";
import { parseHTML } from "linkedom";
import * as marked from "marked";
import { renderMarkdownInto } from "../../src/client/markdown.ts";
import type { ChatImage } from "../../src/shared/contracts.ts";
import { generatedImageMarkdown } from "../../src/shared/image-references.ts";

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

function generatedImages(root: HTMLElement): HTMLImageElement[] {
  return [...root.querySelectorAll<HTMLImageElement>(
    "img.code-interpreter-image[data-generated-image-id]",
  )];
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

test("renders only a first exact image from the current message cache", () => {
  const current: ChatImage = {
    id: "ci-current-call",
    mimeType: "image/png",
    data: "CURRENT",
    alt: "当前图片",
  };
  const root = container();
  const marker = generatedImageMarkdown(current.id, current.alt);

  renderMarkdownInto(root, [
    "![外链](https://example.com/remote.png)",
    "![内联](data:image/png;base64,REMOTE)",
    "![相对路径](./chart.png)",
    "![产物](artifact://chart.png)",
    "![沙箱](sandbox:/work/chart.png)",
    "![跨回合](/__datalens_generated_image__/ci-old-call)",
    "![畸形](/__datalens_generated_image__/ci:raw:1)",
    marker,
    marker,
    '<img src="https://example.com/raw.png">',
  ].join("\n\n"), [current]);

  const allImages = [...root.querySelectorAll<HTMLImageElement>("img")];
  assert.equal(allImages.length, 1);
  assert.equal(allImages[0]?.getAttribute("data-generated-image-id"), current.id);
  assert.equal(allImages[0]?.getAttribute("src"), "data:image/png;base64,CURRENT");
  assert.doesNotMatch(root.innerHTML, /remote\.png|REMOTE|chart\.png|old-call|ci:raw/u);
  assert.match(root.textContent ?? "", /<img src="https:\/\/example\.com\/raw\.png">/u);
});

test("reuses a generated image across incremental renders in the same container", () => {
  const image: ChatImage = {
    id: "ci-call-one",
    mimeType: "image/png",
    data: "AAAA",
    alt: "趋势图",
  };
  const marker = generatedImageMarkdown(image.id, image.alt);
  const thought = container();

  renderMarkdownInto(thought, marker, [image]);
  const initial = generatedImages(thought)[0];
  assert.ok(initial);

  renderMarkdownInto(thought, `分析完成\n\n${marker}`, [image]);
  assert.equal(generatedImages(thought)[0], initial);
});

test("shares generated image claims across separate thought fragments", () => {
  const first: ChatImage = {
    id: "ci-call-one",
    mimeType: "image/png",
    data: "AAAA",
    alt: "第一张",
  };
  const second: ChatImage = {
    id: "ci-call-two",
    mimeType: "image/png",
    data: "BBBB",
    alt: "第二张",
  };
  const firstFragment = container();
  const secondFragment = container();
  const claims = new Set<string>();

  renderMarkdownInto(firstFragment, generatedImageMarkdown(first.id, first.alt), [first, second], {
    claimedGeneratedImageIds: claims,
  });
  renderMarkdownInto(secondFragment, [
    generatedImageMarkdown(first.id, "重复第一张"),
    generatedImageMarkdown(second.id, second.alt),
  ].join("\n\n"), [first, second], {
    claimedGeneratedImageIds: claims,
  });

  assert.deepEqual(
    generatedImages(firstFragment).map((image) => image.getAttribute("data-generated-image-id")),
    [first.id],
  );
  assert.deepEqual(
    generatedImages(secondFragment).map((image) => image.getAttribute("data-generated-image-id")),
    [second.id],
  );
});

test("keeps body and thought image claims independent", () => {
  const shared: ChatImage = {
    id: "ci-call-one",
    mimeType: "image/png",
    data: "SHARED",
    alt: "正文图片",
  };
  const thoughtOnly: ChatImage = {
    id: "ci-call-two",
    mimeType: "image/png",
    data: "THOUGHT_ONLY",
    alt: "思考图片",
  };
  const body = container();
  const thought = container();
  const bodyClaims = new Set<string>();
  const thoughtClaims = new Set<string>();

  renderMarkdownInto(body, generatedImageMarkdown(shared.id, shared.alt), [shared, thoughtOnly], {
    claimedGeneratedImageIds: bodyClaims,
  });
  renderMarkdownInto(thought, [
    generatedImageMarkdown(shared.id, "思考中的重复引用"),
    generatedImageMarkdown(thoughtOnly.id, thoughtOnly.alt),
  ].join("\n\n"), [shared, thoughtOnly], {
    claimedGeneratedImageIds: thoughtClaims,
  });

  assert.deepEqual(
    generatedImages(body).map((image) => image.getAttribute("data-generated-image-id")),
    [shared.id],
  );
  assert.deepEqual(
    generatedImages(thought).map((image) => image.getAttribute("data-generated-image-id")),
    [shared.id, thoughtOnly.id],
  );
});

test("rendering the done body does not move an existing thought image", () => {
  const image: ChatImage = {
    id: "ci-call-one",
    mimeType: "image/png",
    data: "AAAA",
    alt: "共享图片",
  };
  const marker = generatedImageMarkdown(image.id, image.alt);
  const thought = container();
  const body = container();

  renderMarkdownInto(thought, marker, [image]);
  const thoughtImage = generatedImages(thought)[0];
  assert.ok(thoughtImage);

  renderMarkdownInto(body, marker, [image]);
  const bodyImage = generatedImages(body)[0];
  assert.ok(bodyImage);
  assert.notEqual(bodyImage, thoughtImage);
  assert.equal(generatedImages(thought)[0], thoughtImage);
});

test("authoritative redraw replaces changed image data and removes deleted images", () => {
  const streamed: ChatImage = {
    id: "ci-call-one",
    mimeType: "image/png",
    data: "STREAMED",
    alt: "流式图片",
  };
  const finalImage: ChatImage = {
    ...streamed,
    data: "FINAL",
    alt: "最终图片",
  };
  const marker = generatedImageMarkdown(streamed.id, streamed.alt);
  const body = container();

  renderMarkdownInto(body, marker, [streamed]);
  const temporary = generatedImages(body)[0];
  assert.ok(temporary);

  renderMarkdownInto(body, marker, [finalImage]);
  const authoritative = generatedImages(body)[0];
  assert.ok(authoritative);
  assert.notEqual(authoritative, temporary);
  assert.equal(authoritative.getAttribute("src"), "data:image/png;base64,FINAL");

  renderMarkdownInto(body, "最终正文不再引用图片", []);
  assert.equal(generatedImages(body).length, 0);
});
