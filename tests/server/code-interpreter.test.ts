import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { after, before } from "node:test";
import { ArtifactStore } from "../../src/server/tool/artifact-store.ts";
import {
  CodeInterpreterRuntime,
  formatCodeInterpreterResult,
} from "../../src/server/tool/code-interpreter.ts";
import {
  generatedImageMarkdown,
} from "../../src/shared/image-references.ts";

const projectRoot = process.cwd();
let runtime: CodeInterpreterRuntime;
let directory: string;

before(async () => {
  directory = mkdtempSync(path.join(tmpdir(), "sqlite-qa-code-test-"));
  runtime = await CodeInterpreterRuntime.create({
    pythonPath: "/usr/bin/python3",
    bwrapPath: "/usr/bin/bwrap",
    prlimitPath: "/usr/bin/prlimit",
    projectRoot,
  });
});

after(() => {
  runtime.dispose();
  rmSync(directory, { recursive: true, force: true });
});

test("passes sandbox self-check and performs exact inline JSON calculations", async () => {
  assert.deepEqual(runtime.status, { available: true, reason: null });
  const result = await runtime.execute(
    [
      "from decimal import Decimal",
      "print(Decimal(input_data['left']) + Decimal(input_data['right']))",
      `print(__import__('os').path.exists(${JSON.stringify(projectRoot)}))`,
    ].join("\n"),
    '{"left":"0.1","right":"0.2"}',
    undefined,
    undefined,
  );
  assert.equal(result.details.stdout, "0.3\nFalse\n");
  assert.equal(result.details.images.length, 0);
});

test("requires and validates a semantic reference name", async () => {
  const invalidCalls = [
    ["emit_image(image)", /required positional argument|缺少/u],
    ["emit_image(image, '')", /reference_name/u],
    ["emit_image(image, 123)", /reference_name 必须是字符串/u],
    ["emit_image(image, '趋势图')", /reference_name 只能包含/u],
    ["emit_image(image, 'oee@ranking')", /reference_name 只能包含/u],
    ["emit_image(image, 'aaaaaaaaaaaaaaaaaaaaaaaaa')", /不超过 24 个字符/u],
  ] as const;

  for (const [call, expected] of invalidCalls) {
    await assert.rejects(
      () => runtime.execute([
        "from PIL import Image",
        "image = Image.new('RGB', (8, 8), 'white')",
        call,
      ].join("\n"), undefined, undefined, undefined),
      expected,
    );
  }

  const normalized = await runtime.execute([
    "from PIL import Image",
    "image = Image.new('RGB', (8, 8), 'white')",
    "emit_image(image, 'OEE Ranking')",
  ].join("\n"), undefined, undefined, undefined);
  assert.equal(normalized.details.images[0]?.referenceName, "oee-ranking");
  assert.equal(normalized.details.images[0]?.alt, "oee-ranking");
});

test("does not automatically capture Matplotlib figures", async () => {
  const result = await runtime.execute([
    "import matplotlib.pyplot as plt",
    "figure, axis = plt.subplots()",
    "axis.plot([1, 2, 3])",
  ].join("\n"), undefined, undefined, undefined);
  assert.equal(result.details.images.length, 0);
});

test("reads current-session artifacts and captures normalized PNG output", async () => {
  const artifacts = new ArtifactStore(path.join(directory, "artifacts"))
    .forSession("session-12345678");
  const created = artifacts.createJson((fileDescriptor) => {
    const json = JSON.stringify({ columns: ["value"], rows: [{ value: 2 }, { value: 3 }] });
    writeSync(fileDescriptor, json);
    return null;
  });
  const result = await runtime.execute(
    [
      "import matplotlib.pyplot as plt",
      "values = [row['value'] for row in input_data['rows']]",
      "print(sum(values))",
      "figure, axis = plt.subplots()",
      "axis.plot(values)",
      "emit_image(figure, 'value-trend')",
    ].join("\n"),
    created.fileUri,
    artifacts,
    undefined,
  );
  assert.equal(result.details.stdout, "5\n");
  assert.equal(result.details.images.length, 1);
  assert.equal(result.details.images[0]?.mimeType, "image/png");
  assert.equal(result.details.images[0]?.referenceName, "value-trend");
  assert.equal(result.details.images[0]?.alt, "value-trend");
  assert.match(result.details.images[0]?.data ?? "", /^[A-Za-z0-9+/]+=*$/u);
  assert.equal(JSON.parse(result.text).imageDelivery, "attached_to_answer");
  const id = "ci-value-trend";
  const modelText = formatCodeInterpreterResult(result.details, [{
    id,
    markdown: generatedImageMarkdown(id, result.details.images[0]?.alt ?? "value-trend"),
  }]);
  const modelResult = JSON.parse(modelText) as Record<string, unknown>;
  assert.deepEqual(modelResult["imageReferences"], [{
    id: "ci-value-trend",
    markdown: "![value-trend](/__datalens_generated_image__/ci-value-trend)",
  }]);
  assert.equal(modelText.includes(result.details.images[0]?.data ?? "never"), false);
});

test("renders Chinese text with the sandbox-provided Matplotlib and Pillow fonts", async () => {
  const result = await runtime.execute(
    [
      "import matplotlib.pyplot as plt",
      "from matplotlib.font_manager import FontProperties",
      "from PIL import Image, ImageDraw",
      "figure, axis = plt.subplots(figsize=(4, 3))",
      "axis.bar(['运行', '停机'], [8, 2])",
      "axis.set_title('设备时间分布', fontproperties=FontProperties(family='SimHei', weight='bold'))",
      "axis.set_ylabel('小时')",
      "axis.set_xlabel('生产日期', fontproperties=matplotlib_chinese_font(12, bold=True))",
      "plt.tight_layout()",
      "emit_image(figure, 'equipment-time')",
      "canvas = Image.new('RGB', (320, 100), 'white')",
      "ImageDraw.Draw(canvas).text((12, 28), '中文设备状态', font=chinese_font(28, bold=True), fill='black')",
      "emit_image(canvas, 'device-status')",
      "print(CJK_FONT_FAMILY)",
    ].join("\n"),
    undefined,
    undefined,
    undefined,
  );
  assert.match(result.details.stdout, /Noto Sans CJK SC|Droid Sans Fallback|WenQuanYi/u);
  assert.doesNotMatch(result.details.stdout, /Noto Sans CJK JP/u);
  assert.doesNotMatch(result.details.stderr, /Font family 'SimHei' not found/u);
  assert.doesNotMatch(result.details.stderr, /Glyph .* missing from current font/u);
  assert.equal(result.details.images.length, 2);
  assert.deepEqual(
    result.details.images.map((image) => image.referenceName),
    ["equipment-time", "device-status"],
  );
});

test("rejects host paths and aborts a running process", async () => {
  await assert.rejects(
    () => runtime.execute("print(input_data)", "/etc/passwd", undefined, undefined),
    /不是有效 JSON/u,
  );

  const controller = new AbortController();
  const execution = runtime.execute("while True:\n    pass", undefined, undefined, controller.signal);
  setTimeout(() => controller.abort(), 100).unref();
  await assert.rejects(execution, (error) => error instanceof Error && error.name === "AbortError");
});
