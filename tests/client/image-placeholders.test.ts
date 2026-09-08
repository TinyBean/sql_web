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
  generatedImageMarkdown,
  generatedImageReferenceSource,
  isGeneratedImageReferenceName,
  parseGeneratedImageReferenceSource,
  reserveSemanticGeneratedImageId,
  stripGeneratedImageMarkdown,
} from "../../src/shared/image-references.ts";

test("hides every incomplete split of a canonical generated-image marker", () => {
  const before = "正文开始\n\n";
  const markers = [generatedImageMarkdown("ci-oee-ranking", "趋势[图]\\版本")];

  assert.equal(hideTrailingIncompleteGeneratedImageMarkdown(before), before);
  assert.equal(hideTrailingIncompleteGeneratedImageMarkdown(`${before}!`), `${before}!`);
  for (const marker of markers) {
    for (let split = 2; split < marker.length; split += 1) {
      assert.equal(
        hideTrailingIncompleteGeneratedImageMarkdown(before + marker.slice(0, split)),
        before,
        `marker should stay hidden at split ${split}: ${marker.slice(0, split)}`,
      );
    }
    assert.equal(hideTrailingIncompleteGeneratedImageMarkdown(before + marker), before + marker);
  }
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
    String.raw`\![转义](/__datalens_generated_image__/ci-oee-ranking`,
  ];

  for (const source of cases) {
    assert.equal(hideTrailingIncompleteGeneratedImageMarkdown(source), source);
  }

  const evenBackslashes = String.raw`\\![图片](/__datalens_generated_image__/ci-oee-ranking`;
  assert.equal(hideTrailingIncompleteGeneratedImageMarkdown(evenBackslashes), "\\\\");
});

test("does not hide generated-image text inside fenced or inline code", () => {
  const partial = "![图](/__datalens_generated_image__/ci-oee-ranking";
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

test("round-trips only semantic generated-image IDs", () => {
  const id = "ci-equipment-trend-2";
  const source = generatedImageReferenceSource(id);
  const markdown = generatedImageMarkdown(id, "趋势[图]\n第二行");

  assert.equal(source, "/__datalens_generated_image__/ci-equipment-trend-2");
  assert.equal(parseGeneratedImageReferenceSource(source), id);
  assert.equal(parseGeneratedImageReferenceSource("/__datalens_generated_image__/%E0%A4%A"), null);
  assert.equal(parseGeneratedImageReferenceSource("/__datalens_generated_image__/ci:raw:1"), null);
  assert.equal(parseGeneratedImageReferenceSource("/__datalens_generated_image__/ci%3Acall%3A1"), null);
  assert.throws(() => generatedImageReferenceSource("ci:call:1"), /格式无效/u);
  assert.equal(stripGeneratedImageMarkdown(`之前\n\n${markdown}\n\n之后`), "之前\n\n\n\n之后");
});

test("allocates short semantic image IDs and adds suffixes only for collisions", () => {
  const used = new Set<string>();

  assert.equal(isGeneratedImageReferenceName("oee-ranking"), true);
  assert.equal(isGeneratedImageReferenceName("OEE Ranking"), false);
  assert.equal(isGeneratedImageReferenceName("趋势图"), false);
  assert.equal(reserveSemanticGeneratedImageId("oee-ranking", used), "ci-oee-ranking");
  assert.equal(reserveSemanticGeneratedImageId("yield-trend", used), "ci-yield-trend");
  assert.equal(reserveSemanticGeneratedImageId("oee-ranking", used), "ci-oee-ranking-2");
  assert.throws(() => reserveSemanticGeneratedImageId("bad_name", used), /格式无效/u);
  assert.equal(
    generatedImageReferenceSource("ci-oee-ranking"),
    "/__datalens_generated_image__/ci-oee-ranking",
  );
});

test("turns Markdown images into inert markers before DOM parsing", () => {
  const id = "ci-equipment-trend";
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
  const exact = generatedImageMarkdown("ci-exact-chart", "精确");
  const ordinary = "![普通图片](./chart.png)";
  const source = `之前\n${exact}\n${ordinary}\n之后`;

  assert.equal(stripGeneratedImageMarkdown(source), `之前\n\n${ordinary}\n之后`);
});

test("binds only exact image IDs and never consumes images positionally", () => {
  const images: ChatImage[] = [
    { id: "ci-first", mimeType: "image/png", data: "AAAA", alt: "第一张" },
    { id: "ci-second", mimeType: "image/png", data: "BBBB", alt: "第二张" },
    { id: "ci-third", mimeType: "image/png", data: "CCCC", alt: "第三张" },
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
    { kind: "remove" },
    { kind: "remove" },
    { kind: "remove" },
    { kind: "replace", image: images[1] },
    { kind: "remove" },
    { kind: "remove" },
    { kind: "remove" },
    { kind: "remove" },
  ]);
  assert.doesNotMatch(JSON.stringify(layout), /ci-third/u);
});

test("supports exact image reordering without returning unreferenced images", () => {
  const images: ChatImage[] = [
    { id: "ci-chart-one", mimeType: "image/png", data: "AAAA", alt: "第一张" },
    { id: "ci-chart-two", mimeType: "image/png", data: "BBBB", alt: "第二张" },
    { id: "ci-chart-three", mimeType: "image/png", data: "CCCC", alt: "第三张" },
  ];
  const layout = resolveGeneratedImageLayout([
    generatedImageReferenceSource(images[1]?.id ?? ""),
    generatedImageReferenceSource(images[0]?.id ?? ""),
    generatedImageReferenceSource("ci-other-message"),
  ], images);

  assert.deepEqual(layout.resolutions, [
    { kind: "replace", image: images[1] },
    { kind: "replace", image: images[0] },
    { kind: "remove" },
  ]);
  assert.doesNotMatch(JSON.stringify(layout), /ci-chart-three/u);
  assert.deepEqual(resolveGeneratedImageLayout([], images), { resolutions: [] });
});

test("shares generated-image claims across Markdown fragments", () => {
  const images: ChatImage[] = [
    { id: "ci-chart-one", mimeType: "image/png", data: "AAAA", alt: "第一张" },
    { id: "ci-chart-two", mimeType: "image/png", data: "BBBB", alt: "第二张" },
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
  assert.deepEqual([...claims], ["ci-chart-one", "ci-chart-two"]);
});
