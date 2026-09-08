import assert from "node:assert/strict";
import test from "node:test";
import type { ChatImage } from "../../src/shared/contracts.ts";
import {
  generatedImageMarkdown,
  generatedImageReferenceSource,
} from "../../src/shared/image-references.ts";
import {
  createGeneratedTextReviewExtension,
  IMAGE_REFERENCE_REVIEW_MESSAGE_TYPE,
  reviewGeneratedImageReferences,
} from "../../src/server/agent/generated-text-review.ts";

const png = Buffer.from("89504e470d0a1a0a", "hex").toString("base64");

function image(id: string, alt: string): ChatImage {
  return { id, mimeType: "image/png", data: png, alt };
}

test("preserves exact generated-image references and keeps duplicate source text", () => {
  const chart = image("ci-trend", "趋势图");
  const marker = generatedImageMarkdown(chart.id, chart.alt);
  const result = reviewGeneratedImageReferences(`${marker}\n重复:${marker}`, [chart]);

  assert.equal(result.text, `${marker}\n重复:${marker}`);
  assert.equal(result.referenceCount, 2);
  assert.equal(result.exactReferenceCount, 1);
  assert.equal(result.duplicateReferenceCount, 1);
  assert.equal(result.requiresModelReview, false);
});

test("repairs one invalid reference only when exactly one image remains", () => {
  const chart = image("ci-generated", "生成图");
  const result = reviewGeneratedImageReferences("结果如下:![模型说明](sandbox:/work/chart.png)", [chart]);

  assert.equal(
    result.text,
    `结果如下:${generatedImageMarkdown(chart.id, "模型说明")}`,
  );
  assert.equal(result.automaticRepairCount, 1);
  assert.equal(result.unresolvedReferenceCount, 0);
  assert.equal(result.requiresModelReview, false);
});

test("uses an exact claim to make one remaining invalid reference unambiguous", () => {
  const first = image("ci-first", "第一张");
  const second = image("ci-second", "第二张");
  const firstMarker = generatedImageMarkdown(first.id, first.alt);
  const result = reviewGeneratedImageReferences(
    `${firstMarker}\n![保留此说明](https://example.com/wrong.png)`,
    [first, second],
  );

  assert.equal(result.text, [
    firstMarker,
    generatedImageMarkdown(second.id, "保留此说明"),
  ].join("\n"));
  assert.equal(result.exactReferenceCount, 1);
  assert.equal(result.automaticRepairCount, 1);
  assert.equal(result.requiresModelReview, false);
});

test("repairs fixed and semantic descriptions by exact image descriptions", () => {
  const fixedDescription = image("ci-calculation-chart-one", "代码计算图表 1");
  const semantic = image("ci-oee-ranking", "oee-ranking");
  const result = reviewGeneratedImageReferences([
    "![代码计算图表 1](sandbox:/work/calculation.png)",
    "![oee-ranking](https://example.com/ranking.png)",
  ].join("\n"), [fixedDescription, semantic]);

  assert.equal(result.text, [
    generatedImageMarkdown(fixedDescription.id, fixedDescription.alt),
    generatedImageMarkdown(semantic.id, semantic.alt),
  ].join("\n"));
  assert.equal(result.automaticRepairCount, 2);
  assert.equal(result.descriptionRepairCount, 2);
  assert.equal(result.ambiguousDescriptionCount, 0);
  assert.equal(result.unresolvedReferenceCount, 0);
  assert.equal(result.requiresModelReview, false);
});

test("keeps a valid current-turn ID authoritative when its description disagrees", () => {
  const ranking = image("ci-oee-ranking", "oee-ranking");
  const yieldChart = image("ci-yield", "yield-chart");
  const source = generatedImageMarkdown(ranking.id, yieldChart.alt);
  const result = reviewGeneratedImageReferences(source, [ranking, yieldChart]);

  assert.equal(result.text, source);
  assert.equal(result.exactReferenceCount, 1);
  assert.equal(result.descriptionRepairCount, 0);
  assert.equal(result.requiresModelReview, false);
});

test("matches descriptions exactly without case whitespace or separator normalization", () => {
  const chart = image("ci-oee-ranking", "oee-ranking");
  const source = [
    "![OEE-RANKING](./upper.png)",
    "![ oee-ranking](./space.png)",
    "![oee_ranking](./separator.png)",
  ].join("\n");
  const result = reviewGeneratedImageReferences(source, [chart]);

  assert.equal(result.text, source);
  assert.equal(result.descriptionRepairCount, 0);
  assert.equal(result.unresolvedReferenceCount, 3);
  assert.equal(result.requiresModelReview, true);
});

test("does not use description or remaining-image repair for ambiguous descriptions", () => {
  const first = image("ci-ranking", "ranking");
  const second = image("ci-ranking-2", "ranking");
  const exact = generatedImageMarkdown(first.id, "已确认位置");
  const invalid = "![ranking](./wrong.png)";
  const result = reviewGeneratedImageReferences(`${exact}\n${invalid}`, [first, second]);

  assert.equal(result.text, `${exact}\n${invalid}`);
  assert.equal(result.exactReferenceCount, 1);
  assert.equal(result.automaticRepairCount, 0);
  assert.equal(result.ambiguousDescriptionCount, 1);
  assert.equal(result.unresolvedReferenceCount, 1);
  assert.equal(result.issues[0]?.reason, "ambiguous_description");
  assert.equal(result.requiresModelReview, true);
});

test("combines exact claims description repair and the remaining-image fallback", () => {
  const first = image("ci-first", "first-chart");
  const second = image("ci-second", "second-chart");
  const third = image("ci-third", "third-chart");
  const firstMarker = generatedImageMarkdown(first.id, "模型自定义说明");
  const result = reviewGeneratedImageReferences([
    firstMarker,
    "![second-chart](./second.png)",
    "![未知说明](./third.png)",
  ].join("\n"), [first, second, third]);

  assert.equal(result.text, [
    firstMarker,
    generatedImageMarkdown(second.id, second.alt),
    generatedImageMarkdown(third.id, "未知说明"),
  ].join("\n"));
  assert.equal(result.exactReferenceCount, 1);
  assert.equal(result.descriptionRepairCount, 1);
  assert.equal(result.automaticRepairCount, 2);
  assert.equal(result.unresolvedReferenceCount, 0);
});

test("keeps a repeated invalid reference after one unique description claim", () => {
  const chart = image("ci-ranking", "ranking");
  const duplicate = "![ranking](./duplicate.png)";
  const result = reviewGeneratedImageReferences([
    "![ranking](./first.png)",
    duplicate,
  ].join("\n"), [chart]);

  assert.equal(result.text, [
    generatedImageMarkdown(chart.id, chart.alt),
    duplicate,
  ].join("\n"));
  assert.equal(result.descriptionRepairCount, 1);
  assert.equal(result.duplicateReferenceCount, 1);
  assert.equal(result.unresolvedReferenceCount, 0);
  assert.equal(result.requiresModelReview, false);
});

test("keeps ambiguous or unapproved addresses and requests model review", () => {
  const images = [
    image("ci-first", "第一张"),
    image("ci-second", "第二张"),
  ];
  const source = [
    "前文",
    "![外链](https://example.com/chart.png)",
    "![内联](data:image/png;base64,AAAA)",
    "![产物](artifact://chart.png)",
    "![沙箱](sandbox:/work/chart.png)",
    "![相对路径](./chart.png)",
    `![跨回合](${generatedImageReferenceSource("ci-other-turn")})`,
    "后文",
  ].join("\n");
  const result = reviewGeneratedImageReferences(source, images);

  assert.equal(result.referenceCount, 6);
  assert.equal(result.unresolvedReferenceCount, 6);
  assert.equal(result.requiresModelReview, true);
  assert.equal(result.issues.length, 6);
  assert.equal(result.text, source);
});

test("treats an image reference without generated images as unresolved", () => {
  const result = reviewGeneratedImageReferences("说明 ![不存在](./missing.png)", []);

  assert.equal(result.text, "说明 ![不存在](./missing.png)");
  assert.equal(result.unresolvedReferenceCount, 1);
  assert.equal(result.requiresModelReview, true);
});

test("ignores code, escaped syntax, ordinary links, and raw HTML images", () => {
  const chart = image("ci-real-image", "真实图片");
  const source = [
    "`![行内代码](./inline.png)`",
    "```md",
    "![围栏代码](./fenced.png)",
    "```",
    "    ![缩进代码](./indented.png)",
    "\\![转义图片](./escaped.png)",
    `[普通链接](${generatedImageReferenceSource(chart.id)})`,
    '<img src="./raw-html.png">',
    "![真实图片][chart]",
    "",
    `[chart]: ${generatedImageReferenceSource(chart.id)}`,
  ].join("\n");
  const result = reviewGeneratedImageReferences(source, [chart]);

  assert.equal(result.text, source);
  assert.equal(result.referenceCount, 1);
  assert.equal(result.exactReferenceCount, 1);
  assert.equal(result.requiresModelReview, false);
});

test("rewrites the rendered occurrence when identical image syntax also appears in code", () => {
  const chart = image("ci-real-image", "真实图片");
  const invalid = "![相同语法](./wrong.png)";
  const source = [
    `    ${invalid}`,
    "",
    invalid,
  ].join("\n");
  const result = reviewGeneratedImageReferences(source, [chart]);

  assert.equal(result.text, [
    `    ${invalid}`,
    "",
    generatedImageMarkdown(chart.id, "相同语法"),
  ].join("\n"));
  assert.equal(result.referenceCount, 1);
  assert.equal(result.automaticRepairCount, 1);
});

test("the extension queues one hidden rewrite without deleting unresolved source text", async () => {
  const handlers = new Map<string, (...arguments_: never[]) => unknown>();
  const sent: Array<{ readonly message: unknown; readonly options: unknown }> = [];
  const logs: Array<{ readonly level: string; readonly event: string; readonly fields: unknown }> = [];
  const extension = createGeneratedTextReviewExtension({
    info: (event, fields) => logs.push({ level: "info", event, fields }),
    warn: (event, fields) => logs.push({ level: "warn", event, fields }),
  });
  const factory = typeof extension === "function" ? extension : extension.factory;
  await factory({
    on: (event: string, handler: (...arguments_: never[]) => unknown) => handlers.set(event, handler),
    sendMessage: (message: unknown, options: unknown) => sent.push({ message, options }),
  } as never);
  const context = { sessionManager: { getSessionId: () => "review-session" } };
  const emit = async (event: string, value: unknown): Promise<unknown> => (
    handlers.get(event)?.(value as never, context as never)
  );

  await emit("message_end", {
    type: "message_end",
    message: { role: "user", content: [{ type: "text", text: "画两张图" }], timestamp: 1 },
  });
  for (const [toolCallId, referenceName] of [
    ["code-1", "first-chart"],
    ["code-2", "second-chart"],
  ] as const) {
    await emit("message_end", {
      type: "message_end",
      message: {
        role: "toolResult",
        toolCallId,
        toolName: "code_interpreter",
        content: [{ type: "text", text: "private" }],
        isError: false,
        details: {
          kind: "code_interpreter",
          images: [{
            mimeType: "image/png",
            data: png,
            alt: referenceName,
            referenceName,
            referenceId: `ci-${referenceName}`,
          }],
        },
        timestamp: 2,
      },
    });
  }

  const candidate = {
    role: "assistant",
    content: [
      { type: "thinking", thinking: "保留思考" },
      { type: "text", text: "图表:![一](./one.png) ![二](./two.png)" },
    ],
    stopReason: "stop",
    timestamp: 3,
  };
  const candidateResult = await emit("message_end", { type: "message_end", message: candidate });
  assert.equal(candidateResult, undefined);

  await emit("turn_end", { type: "turn_end", turnIndex: 1, message: candidate, toolResults: [] });
  assert.equal(sent.length, 1);
  assert.deepEqual((sent[0]?.message as { customType?: string; display?: boolean }), {
    ...(sent[0]?.message as object),
    customType: IMAGE_REFERENCE_REVIEW_MESSAGE_TYPE,
    display: false,
  });
  assert.deepEqual(sent[0]?.options, { deliverAs: "followUp" });
  const hiddenContent = (sent[0]?.message as { content?: string }).content ?? "";
  assert.match(hiddenContent, /candidate_answer/u);
  assert.match(hiddenContent, /\.\/one\.png/u);
  assert.match(hiddenContent, /ci-first-chart/u);
  assert.match(hiddenContent, /保留候选回答中的原始引用/u);
  assert.doesNotMatch(JSON.stringify(logs), /ci-first-chart|one\.png|candidate_answer/u);

  assert.deepEqual(await emit("tool_call", { type: "tool_call" }), {
    block: true,
    reason: "图片引用复核阶段不得调用工具,请直接输出修正后的完整回答",
  });

  const rewrite = {
    role: "assistant",
    content: [{ type: "text", text: "修正版 ![仍错误](https://example.com/wrong.png)" }],
    stopReason: "stop",
    timestamp: 4,
  };
  const rewriteResult = await emit("message_end", { type: "message_end", message: rewrite });
  assert.equal(rewriteResult, undefined);
  await emit("turn_end", { type: "turn_end", turnIndex: 2, message: rewrite, toolResults: [] });
  assert.equal(sent.length, 1);
  assert.equal(await emit("tool_call", { type: "tool_call" }), undefined);
  assert.equal(
    logs.filter(({ event }) => event === "agent.image_reference_review.started").length,
    1,
  );
});

test("the extension does not queue a rewrite after description repairs", async () => {
  const handlers = new Map<string, (...arguments_: never[]) => unknown>();
  const sent: unknown[] = [];
  const logs: Array<{ readonly event: string; readonly fields: unknown }> = [];
  const extension = createGeneratedTextReviewExtension({
    info: (event, fields) => logs.push({ event, fields }),
    warn: (event, fields) => logs.push({ event, fields }),
  });
  const factory = typeof extension === "function" ? extension : extension.factory;
  await factory({
    on: (event: string, handler: (...arguments_: never[]) => unknown) => handlers.set(event, handler),
    sendMessage: (message: unknown) => sent.push(message),
  } as never);
  const context = { sessionManager: { getSessionId: () => "description-review-session" } };
  const emit = async (event: string, value: unknown): Promise<unknown> => (
    handlers.get(event)?.(value as never, context as never)
  );

  await emit("message_end", {
    type: "message_end",
    message: { role: "user", content: [{ type: "text", text: "画图" }], timestamp: 1 },
  });
  await emit("message_end", {
    type: "message_end",
    message: {
      role: "toolResult",
      toolCallId: "code-1",
      toolName: "code_interpreter",
      content: [{ type: "text", text: "private" }],
      isError: false,
      details: {
        kind: "code_interpreter",
        images: [{
          mimeType: "image/png",
          data: png,
          alt: "oee-ranking",
          referenceName: "oee-ranking",
          referenceId: "ci-oee-ranking",
        }],
      },
      timestamp: 2,
    },
  });

  const candidate = {
    role: "assistant",
    content: [{ type: "text", text: "![oee-ranking](./wrong.png)" }],
    stopReason: "stop",
    timestamp: 3,
  };
  const result = await emit("message_end", { type: "message_end", message: candidate });
  assert.equal(
    (result as { message?: { content?: Array<{ text?: string }> } }).message?.content?.[0]?.text,
    generatedImageMarkdown("ci-oee-ranking", "oee-ranking"),
  );
  await emit("turn_end", { type: "turn_end", turnIndex: 1, message: candidate, toolResults: [] });

  assert.equal(sent.length, 0);
  const checked = logs.find(({ event }) => event === "agent.image_reference_review.checked");
  assert.equal(
    (checked?.fields as { descriptionRepairCount?: number }).descriptionRepairCount,
    1,
  );
  assert.doesNotMatch(JSON.stringify(logs), /oee-ranking|wrong\.png/u);
});
