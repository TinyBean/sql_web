import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { after, before } from "node:test";
import {
  CodeInterpreterRuntime,
  formatCodeInterpreterResult,
  type CodeInterpreterInput,
} from "../../src/server/tool/code-interpreter.ts";
import { generatedImageMarkdown } from "../../src/shared/image-references.ts";
import type { JsonObject } from "../../src/shared/contracts.ts";
import { initializeOeeDatabase } from "../../scripts/database/initialize.ts";
import { ArtifactStore } from "../../src/server/tool/artifact-store.ts";
import { createAgentTools } from "../../src/server/tool/database-tools.ts";
import { AppDatabase } from "../../src/server/database/database.ts";

const projectRoot = process.cwd();
let runtime: CodeInterpreterRuntime;
let directory: string;
let inputIndex = 0;

function trustedInput(
  rows: readonly Record<string, unknown>[] = [],
  userInput: JsonObject | null = null,
): CodeInterpreterInput {
  const columns = rows.length === 0 ? [] : Object.keys(rows[0] ?? {});
  const json = JSON.stringify({
    columns,
    rows,
    rowCount: rows.length,
    truncated: false,
    truncationReason: null,
  });
  const databasePath = path.join(directory, `database-input-${inputIndex += 1}.json`);
  writeFileSync(databasePath, json, { mode: 0o600 });
  return {
    snapshot: {
      name: `test-data-${inputIndex}`,
      version: `test-version-${inputIndex}`,
      createdAt: "2026-09-09T00:00:00.000Z",
      databasePath,
      rowCount: rows.length,
      byteCount: Buffer.byteLength(json),
    },
    userInput,
  };
}

function noSnapshotInput(userInput: JsonObject | null = null): CodeInterpreterInput {
  return { snapshot: null, userInput };
}

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

test("passes sandbox self-check and consumes separate trusted database and user inputs", async () => {
  assert.deepEqual(runtime.status, { available: true, reason: null });
  const result = await runtime.execute(
    [
      "from decimal import Decimal",
      "row = snapshot_rows[0]",
      "total = Decimal(row.left) + Decimal(input_data.user.right)",
      "emit_result({'summary': 'exact sum', 'metrics': {'total': str(total)}, 'intermediates': {'rowCount': input_data['database']['rowCount']}})",
      "print(total)",
      `print(__import__('os').path.exists(${JSON.stringify(projectRoot)}))`,
    ].join("\n"),
    trustedInput([{ left: "0.1" }], { right: "0.2" }),
    undefined,
  );
  assert.equal(result.details.stdout, "0.3\nFalse\n");
  assert.deepEqual(result.details.result, {
    summary: "exact sum",
    metrics: { total: "0.3" },
    intermediates: { rowCount: 1 },
  });
  assert.equal(result.details.provenance.source, "sqlite");
  assert.equal(result.details.provenance.snapshotName, "test-data-1");
  assert.equal(result.details.provenance.snapshotVersion, "test-version-1");
  assert.equal(result.details.provenance.rowCount, 1);
  assert.equal(result.details.provenance.truncated, false);
  assert.equal(result.details.provenance.hasUserInput, true);
  assert.equal(result.details.images.length, 0);
});

test("saves a query snapshot and reuses it in Python without passing SQL", async () => {
  const filePath = path.join(directory, "integration.sqlite");
  initializeOeeDatabase(filePath);
  const database = AppDatabase.open({ filePath });
  const artifactRoot = path.join(directory, "integration-artifacts");
  const artifacts = new ArtifactStore(artifactRoot).forSession("session-12345678");
  try {
    const tools = createAgentTools(database, artifacts, runtime) as readonly {
      name: string;
      execute(
        id: string,
        params: Record<string, unknown>,
        signal: AbortSignal | undefined,
        onUpdate: undefined,
        context: never,
      ): Promise<{ content: readonly { type: string; text?: string }[]; details: unknown }>;
    }[];
    const executeSql = tools.find((tool) => tool.name === "execute_sql");
    const interpreter = tools.find((tool) => tool.name === "code_interpreter");
    assert.ok(executeSql);
    assert.ok(interpreter);
    const saved = await executeSql.execute(
      "save-integration",
      {
        sql: "SELECT value FROM json_each('[2,3]') ORDER BY value",
        save_as: "Integration Values",
      },
      undefined,
      undefined,
      undefined as never,
    );
    const savedPayload = JSON.parse(saved.content[0]?.text ?? "{}") as {
      snapshot: { name: string };
    };
    assert.equal(savedPayload.snapshot.name, "integration-values");
    const execution = await interpreter.execute(
      "trusted-integration",
      {
        snapshot: savedPayload.snapshot.name,
        code: [
          "values = [row['value'] for row in input_data['database']['rows']]",
          "emit_result({'summary':'database sum','metrics':{'total':sum(values)},'intermediates':{'values':values}})",
        ].join("\n"),
      },
      undefined,
      undefined,
      undefined as never,
    );
    const payload = JSON.parse(execution.content[0]?.text ?? "{}") as {
      result: { metrics: { total: number } };
      provenance: {
        source: string;
        snapshotName: string | null;
        rowCount: number;
        byteCount: number;
        truncated: boolean;
        hasUserInput: boolean;
      };
    };
    assert.equal(payload.result.metrics.total, 5);
    assert.equal(payload.provenance.source, "sqlite");
    assert.equal(payload.provenance.snapshotName, "integration-values");
    assert.equal(payload.provenance.rowCount, 2);
    assert.ok(payload.provenance.byteCount > 0);
    assert.equal(payload.provenance.truncated, false);
    assert.equal(payload.provenance.hasUserInput, false);
    const storedFiles = readdirSync(path.join(artifactRoot, "session-12345678"));
    assert.equal(storedFiles.includes(savedPayload.snapshot.name), false);
    assert.equal(storedFiles.includes("snapshots.json"), true);
    assert.equal(storedFiles.filter((name) => /^[0-9a-f-]+\.json$/u.test(name)).length, 1);
  } finally {
    database.close();
  }
});

test("runs general Python with an explicit null database input", async () => {
  const result = await runtime.execute(
    [
      "assert input_data['database'] is None",
      "emit_result({'summary':'pure python','metrics':{'total':sum([2,3])}})",
    ].join("\n"),
    noSnapshotInput(),
    undefined,
  );
  assert.equal(result.details.result.metrics?.["total"], 5);
  assert.deepEqual(result.details.provenance, {
    source: "none",
    snapshotName: null,
    snapshotVersion: null,
    snapshotCreatedAt: null,
    rowCount: 0,
    byteCount: 0,
    truncated: false,
    hasUserInput: false,
  });
});

test("requires one result and safely normalizes common result shapes", async () => {
  await assert.rejects(
    () => runtime.execute("print('missing')", trustedInput(), undefined),
    /必须且只能调用一次 emit_result/u,
  );
  await assert.rejects(
    () => runtime.execute(
      "emit_result({'summary':'first'})\nemit_result({'summary':'second'})",
      trustedInput(),
      undefined,
    ),
    /只能调用一次 emit_result/u,
  );
  const normalized = await runtime.execute(
    "emit_result(metrics={'value': 1}, notes='single note', extra_value=2)",
    trustedInput(),
    undefined,
  );
  assert.deepEqual(normalized.details.result, {
    summary: "计算完成",
    metrics: { value: 1 },
    data: { extra_value: 2 },
    notes: ["single note"],
  });
  await assert.rejects(
    () => runtime.execute(
      "emit_result({'summary':'large','data':'x' * 70000})",
      trustedInput(),
      undefined,
    ),
    /小于等于 65536 字节/u,
  );
  await assert.rejects(
    () => runtime.execute(
      "emit_result({'summary':'unused'})",
      trustedInput([], { payload: "x".repeat(300_000) }),
      undefined,
    ),
    /user_input 不能超过/u,
  );
});

test("adds the exact snapshot row contract to Python retry errors", async () => {
  await assert.rejects(
    () => runtime.execute(
      [
        "columns = input_data.database.columns",
        "rebuilt = [dict(zip(columns, row)) for row in snapshot_rows]",
        "round(rebuilt[0]['value'], 2)",
      ].join("\n"),
      trustedInput([{ value: 1 }]),
      undefined,
    ),
    /snapshot_rows 是 list\[dict\].*不要再执行 zip/u,
  );
});

test("requires and validates a semantic image reference name", async () => {
  const invalidCalls = [
    ["emit_image(image)", /required positional argument|缺少/u],
    ["emit_image(image, '')", /reference_name/u],
    ["emit_image(image, 123)", /reference_name 必须是字符串/u],
    ["emit_image(image, '趋势图')", /必须包含有意义的英文字母/u],
    ["emit_image(image, '12345')", /必须包含有意义的英文字母/u],
    [`emit_image(image, '${"a".repeat(51)}')`, /不能超过 50 个字符/u],
  ] as const;

  for (const [call, expected] of invalidCalls) {
    await assert.rejects(
      () => runtime.execute([
        "from PIL import Image",
        "image = Image.new('RGB', (8, 8), 'white')",
        call,
      ].join("\n"), trustedInput(), undefined),
      expected,
    );
  }

  const normalized = await runtime.execute([
    "from PIL import Image",
    "image = Image.new('RGB', (8, 8), 'white')",
    "emit_image(image, '2026 OEE / Top 10')",
    "emit_result({'summary':'rendered'})",
  ].join("\n"), trustedInput(), undefined);
  assert.equal(normalized.details.images[0]?.referenceName, "2026-oee-top-10");
  assert.equal(normalized.details.images[0]?.alt, "2026-oee-top-10");
});

test("does not automatically capture Matplotlib figures", async () => {
  const result = await runtime.execute([
    "import matplotlib.pyplot as plt",
    "figure, axis = plt.subplots()",
    "axis.plot([1, 2, 3])",
    "emit_result({'summary':'not emitted'})",
  ].join("\n"), trustedInput(), undefined);
  assert.equal(result.details.images.length, 0);
});

test("captures normalized PNG output with structured provenance", async () => {
  const result = await runtime.execute(
    [
      "import matplotlib.pyplot as plt",
      "values = [row['value'] for row in input_data['database']['rows']]",
      "total = sum(values)",
      "figure, axis = plt.subplots()",
      "axis.plot(values)",
      "emit_image(figure, 'value-trend')",
      "emit_result({'summary':'summed values','metrics':{'total':total},'data':values})",
      "print(total)",
    ].join("\n"),
    trustedInput([{ value: 2 }, { value: 3 }]),
    undefined,
  );
  assert.equal(result.details.stdout, "5\n");
  assert.equal(result.details.result.metrics?.["total"], 5);
  assert.equal(result.details.images.length, 1);
  assert.equal(result.details.images[0]?.mimeType, "image/png");
  assert.equal(result.details.images[0]?.referenceName, "value-trend");
  assert.match(result.details.images[0]?.data ?? "", /^[A-Za-z0-9+/]+=*$/u);
  assert.equal(JSON.parse(result.text).imageDelivery, "attached_to_answer");
  const id = "ci-value-trend";
  const modelText = formatCodeInterpreterResult(result.details, [{
    id,
    markdown: generatedImageMarkdown(id, result.details.images[0]?.alt ?? "value-trend"),
  }]);
  const modelResult = JSON.parse(modelText) as Record<string, unknown>;
  assert.deepEqual(modelResult["result"], result.details.result);
  assert.deepEqual(modelResult["provenance"], result.details.provenance);
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
      "emit_result({'summary':'中文图片已生成'})",
      "print(CJK_FONT_FAMILY)",
    ].join("\n"),
    trustedInput(),
    undefined,
  );
  assert.match(result.details.stdout, /Noto Sans CJK SC|Droid Sans Fallback|WenQuanYi/u);
  assert.doesNotMatch(result.details.stdout, /Noto Sans CJK JP/u);
  assert.doesNotMatch(result.details.stderr, /Font family 'SimHei' not found/u);
  assert.doesNotMatch(result.details.stderr, /Glyph .* missing from current font/u);
  assert.deepEqual(
    result.details.images.map((image) => image.referenceName),
    ["equipment-time", "device-status"],
  );
});

test("rejects invalid database input metadata and aborts a running process", async () => {
  const invalid = trustedInput();
  if (invalid.snapshot === null) throw new Error("test snapshot missing");
  const invalidSnapshot = invalid.snapshot;
  await assert.rejects(
    () => runtime.execute(
      "emit_result({'summary':'invalid'})",
      {
        ...invalid,
        snapshot: { ...invalidSnapshot, byteCount: invalidSnapshot.byteCount + 1 },
      },
      undefined,
    ),
    /数据库输入文件无效/u,
  );

  const controller = new AbortController();
  const execution = runtime.execute("while True:\n    pass", trustedInput(), controller.signal);
  setTimeout(() => controller.abort(), 100).unref();
  await assert.rejects(execution, (error) => error instanceof Error && error.name === "AbortError");
});
