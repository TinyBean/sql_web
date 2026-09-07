import assert from "node:assert/strict";
import test from "node:test";
import * as marked from "marked";
import {
  hideTrailingIncompleteGeneratedImageMarkdown,
  resolveGeneratedImageLayout,
} from "../../src/client/image-placeholders.ts";
import { parseMarkdownWithImagePlaceholders } from "../../src/client/markdown-parser.ts";
import type { ChatImage } from "../../src/shared/contracts.ts";
import {
  createGeneratedImageId,
  generatedImageMarkdown,
  generatedImageReferenceSource,
  parseGeneratedImageReferenceSource,
  stripGeneratedImageMarkdown,
} from "../../src/shared/image-references.ts";

test("hides every incomplete split of a canonical generated-image marker", () => {
  const before = "正文开始\n\n";
  const marker = generatedImageMarkdown(
    createGeneratedImageId("call/with spaces", 2),
    "趋势[图]\\版本",
  );

  assert.equal(hideTrailingIncompleteGeneratedImageMarkdown(before), before);
  assert.equal(hideTrailingIncompleteGeneratedImageMarkdown(`${before}!`), `${before}!`);
  for (let split = 2; split < marker.length; split += 1) {
    assert.equal(
      hideTrailingIncompleteGeneratedImageMarkdown(before + marker.slice(0, split)),
      before,
      `marker should stay hidden at split ${split}: ${marker.slice(0, split)}`,
    );
  }
  assert.equal(hideTrailingIncompleteGeneratedImageMarkdown(before + marker), before + marker);
});

test("reveals image-like text as soon as it diverges from a generated marker", () => {
  const cases = [
    "![普通](https://example.com/image.png",
    "![相对路径](./chart.png",
    "![错误前缀](/__datalens_generated_imagX/image",
    "![错误 ID](/__datalens_generated_image__/not-ci",
    "![错误编码](/__datalens_generated_image__/%G",
    "![未转义[括号](",
    "![错误\\q",
    "![换行\n文字](",
    String.raw`\![转义](/__datalens_generated_image__/ci%3Acall%3A1`,
  ];

  for (const source of cases) {
    assert.equal(hideTrailingIncompleteGeneratedImageMarkdown(source), source);
  }

  const evenBackslashes = String.raw`\\![图片](/__datalens_generated_image__/ci%3Acall%3A1`;
  assert.equal(hideTrailingIncompleteGeneratedImageMarkdown(evenBackslashes), "\\\\");
});

test("does not hide generated-image text inside fenced or inline code", () => {
  const partial = "![图](/__datalens_generated_image__/ci%3Acall%3A1";
  const fenced = `\`\`\`markdown\n${partial}`;
  const tildeFenced = `~~~markdown\n${partial}`;
  const indented = `    ${partial}`;
  const tabIndented = `\t${partial}`;
  const inline = `正文 \`${partial}`;
  const closedInline = `正文 \`${partial}\``;

  assert.equal(hideTrailingIncompleteGeneratedImageMarkdown(fenced), fenced);
  assert.equal(hideTrailingIncompleteGeneratedImageMarkdown(tildeFenced), tildeFenced);
  assert.equal(hideTrailingIncompleteGeneratedImageMarkdown(indented), indented);
  assert.equal(hideTrailingIncompleteGeneratedImageMarkdown(tabIndented), tabIndented);
  assert.equal(hideTrailingIncompleteGeneratedImageMarkdown(inline), inline);
  assert.equal(hideTrailingIncompleteGeneratedImageMarkdown(closedInline), closedInline);

  const afterFence = `\`\`\`markdown\n示例\n\`\`\`\n${partial}`;
  assert.equal(
    hideTrailingIncompleteGeneratedImageMarkdown(afterFence),
    "```markdown\n示例\n```\n",
  );
});

test("creates stable generated-image IDs and round-trips their Markdown references", () => {
  const id = createGeneratedImageId("call/with spaces", 2);
  const source = generatedImageReferenceSource(id);
  const markdown = generatedImageMarkdown(id, "趋势[图]\n第二行");

  assert.equal(id, "ci:call/with spaces:2");
  assert.equal(source, "/__datalens_generated_image__/ci%3Acall%2Fwith%20spaces%3A2");
  assert.equal(parseGeneratedImageReferenceSource(source), id);
  assert.equal(parseGeneratedImageReferenceSource("/__datalens_generated_image__/%E0%A4%A"), null);
  assert.equal(parseGeneratedImageReferenceSource("/__datalens_generated_image__/ci:raw:1"), null);
  assert.equal(parseGeneratedImageReferenceSource("/__datalens_generated_image__/ci%3acall%3a1"), null);
  assert.equal(stripGeneratedImageMarkdown(`之前\n\n${markdown}\n\n之后`), "之前\n\n\n\n之后");

  const punctuationId = createGeneratedImageId("call()!'*", 1);
  assert.equal(
    generatedImageReferenceSource(punctuationId),
    "/__datalens_generated_image__/ci%3Acall%28%29%21%27%2A%3A1",
  );
  assert.equal(parseGeneratedImageReferenceSource(generatedImageReferenceSource(punctuationId)), punctuationId);
});

test("turns Markdown images into inert markers before DOM parsing", () => {
  const id = createGeneratedImageId("call-1", 1);
  const reference = generatedImageMarkdown(id, "趋势图");
  const parsed = parseMarkdownWithImagePlaceholders(marked, [
    reference,
    "![站内图片](./saved/chart.png)",
    '<img src="/__datalens_generated_image__/forged" srcset="/api/private">',
    "```markdown",
    reference,
    "```",
  ].join("\n\n"));
  const { html } = parsed;

  assert.deepEqual(parsed.imageReferences, [
    { source: generatedImageReferenceSource(id), alt: "趋势图", title: null },
    { source: "./saved/chart.png", alt: "站内图片", title: null },
  ]);
  assert.match(html, /<span class="markdown-image-reference" id="markdown-image-reference-0"><\/span>/u);
  assert.match(html, /markdown-image-reference-1/u);
  assert.doesNotMatch(html, /<img(?:\s|>)/u);
  assert.match(html, /&lt;img src=&quot;\/__datalens_generated_image__\/forged&quot; srcset=&quot;\/api\/private&quot;&gt;/u);
  assert.match(html, /<code class="language-markdown">\s*![\s\S]*__datalens_generated_image__/u);
});

test("strips only exact generated-image Markdown in plain-text fallback", () => {
  const exact = generatedImageMarkdown(createGeneratedImageId("call-1", 1), "精确");
  const ordinary = "![普通图片](./chart.png)";
  const source = `之前\n${exact}\n${ordinary}\n之后`;

  assert.equal(stripGeneratedImageMarkdown(source), `之前\n\n${ordinary}\n之后`);
});

test("binds only exact image IDs and never consumes images positionally", () => {
  const images: ChatImage[] = [
    { id: "ci:first:1", mimeType: "image/png", data: "AAAA", alt: "第一张" },
    { id: "ci:second:1", mimeType: "image/png", data: "BBBB", alt: "第二张" },
    { id: "ci:third:1", mimeType: "image/png", data: "CCCC", alt: "第三张" },
  ];
  const secondReference = generatedImageReferenceSource(images[1]?.id ?? "");
  const layout = resolveGeneratedImageLayout([
    "artifact://image.png",
    "sandbox:/work/image.png",
    "/work/image.png",
    secondReference,
    secondReference,
    "/__datalens_generated_image__/bad/path",
    "https://example.com/real.png",
    "data:image/png;base64,DDDD",
  ], images);

  assert.deepEqual(layout.resolutions, [
    { kind: "preserve" },
    { kind: "preserve" },
    { kind: "preserve" },
    { kind: "replace", image: images[1] },
    { kind: "remove" },
    { kind: "remove" },
    { kind: "preserve" },
    { kind: "preserve" },
  ]);
  assert.doesNotMatch(JSON.stringify(layout), /ci:third:1/u);
});

test("supports exact image reordering without returning unreferenced images", () => {
  const images: ChatImage[] = [
    { id: "ci:chart:1", mimeType: "image/png", data: "AAAA", alt: "第一张" },
    { id: "ci:chart:2", mimeType: "image/png", data: "BBBB", alt: "第二张" },
    { id: "ci:chart:3", mimeType: "image/png", data: "CCCC", alt: "第三张" },
  ];
  const layout = resolveGeneratedImageLayout([
    generatedImageReferenceSource(images[1]?.id ?? ""),
    generatedImageReferenceSource(images[0]?.id ?? ""),
    generatedImageReferenceSource("ci:other-message:1"),
  ], images);

  assert.deepEqual(layout.resolutions, [
    { kind: "replace", image: images[1] },
    { kind: "replace", image: images[0] },
    { kind: "remove" },
  ]);
  assert.doesNotMatch(JSON.stringify(layout), /ci:chart:3/u);
  assert.deepEqual(resolveGeneratedImageLayout([], images), { resolutions: [] });
});

test("shares generated-image claims across Markdown fragments", () => {
  const images: ChatImage[] = [
    { id: "ci:chart:1", mimeType: "image/png", data: "AAAA", alt: "第一张" },
    { id: "ci:chart:2", mimeType: "image/png", data: "BBBB", alt: "第二张" },
  ];
  const claims = new Set<string>();

  const first = resolveGeneratedImageLayout([
    generatedImageReferenceSource(images[0]?.id ?? ""),
  ], images, claims);
  const second = resolveGeneratedImageLayout([
    generatedImageReferenceSource(images[0]?.id ?? ""),
    generatedImageReferenceSource(images[1]?.id ?? ""),
  ], images, claims);

  assert.deepEqual(first.resolutions, [{ kind: "replace", image: images[0] }]);
  assert.deepEqual(second.resolutions, [
    { kind: "remove" },
    { kind: "replace", image: images[1] },
  ]);
  assert.deepEqual([...claims], ["ci:chart:1", "ci:chart:2"]);
});
