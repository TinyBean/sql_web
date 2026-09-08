import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { initializeOeeDatabase } from "../../scripts/database/initialize.ts";
import { ArtifactStore } from "../../src/server/tool/artifact-store.ts";
import { CodeInterpreterRuntime } from "../../src/server/tool/code-interpreter.ts";
import { createAgentTools } from "../../src/server/tool/database-tools.ts";
import { AppDatabase } from "../../src/server/database/database.ts";

interface ToolResult {
  readonly content: readonly { readonly type: string; readonly text?: string }[];
  readonly details: unknown;
}

interface CallableTool {
  readonly name: string;
  readonly description: string;
  execute(
    id: string,
    params: Record<string, unknown>,
    signal: AbortSignal | undefined,
    onUpdate: undefined,
    context: never,
  ): Promise<ToolResult>;
}

test("execute_sql defaults to 200 inline rows and emits bounded JSON artifacts", async (t) => {
  const directory = mkdtempSync(path.join(tmpdir(), "sqlite-qa-tools-"));
  let database: AppDatabase | undefined;
  let runtime: CodeInterpreterRuntime | undefined;
  t.after(() => {
    runtime?.dispose();
    database?.close();
    rmSync(directory, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 50,
    });
  });
  const filePath = path.join(directory, "oee.sqlite");
  initializeOeeDatabase(filePath);
  database = AppDatabase.open({ filePath });
  runtime = await CodeInterpreterRuntime.create({
    pythonPath: path.join(directory, "missing-python"),
    bwrapPath: path.join(directory, "missing-bwrap"),
    prlimitPath: path.join(directory, "missing-prlimit"),
    projectRoot: directory,
  });
  const artifacts = new ArtifactStore(path.join(directory, "artifacts"))
    .forSession("session-12345678");
  const tools = createAgentTools(database, artifacts, runtime) as readonly CallableTool[];
  assert.deepEqual(tools.map((tool) => tool.name), ["execute_sql", "get_current_time"]);
  const executeSql = tools.find((tool) => tool.name === "execute_sql");
  assert.ok(executeSql);

  const inline = await executeSql.execute("inline", {
    sql: "WITH RECURSIVE numbers(value) AS (VALUES(1) UNION ALL SELECT value + 1 FROM numbers WHERE value < 201) SELECT value FROM numbers",
  }, undefined, undefined, undefined as never);
  const inlineText = inline.content[0]?.text;
  assert.equal(typeof inlineText, "string");
  const inlineResult = JSON.parse(inlineText ?? "{}") as Record<string, unknown>;
  assert.equal(inlineResult["rowCount"], 200);
  assert.equal(inlineResult["truncated"], true);

  await assert.rejects(
    () => executeSql.execute("invalid-inline", {
      sql: "SELECT 1",
      output_format: "inline",
      limit: 201,
    }, undefined, undefined, undefined as never),
    /不能超过 200/u,
  );

  const file = await executeSql.execute("file", {
    sql: "SELECT value FROM json_each('[1,2,3,4]') ORDER BY value",
    output_format: "json_file",
    limit: 3,
  }, undefined, undefined, undefined as never);
  const fileText = file.content[0]?.text;
  const fileResult = JSON.parse(fileText ?? "{}") as Record<string, unknown>;
  assert.equal(fileResult["outputFormat"], "json_file");
  assert.equal(fileResult["rowCount"], 3);
  assert.equal(fileResult["truncated"], true);
  const fileUri = String(fileResult["fileUri"]);
  const exported = JSON.parse(readFileSync(artifacts.resolveJsonUri(fileUri), "utf8")) as
    Record<string, unknown>;
  assert.equal(exported["rowCount"], 3);
  assert.equal(exported["truncationReason"], "row_limit");

  const generatedImageData = "PRIVATE_GENERATED_IMAGE_DATA";
  const availableRuntime = {
    status: { available: true, reason: null },
    execute: async () => ({
      text: "legacy result text",
      details: {
        kind: "code_interpreter" as const,
        stdout: "rendered\n",
        stderr: "",
        stdoutTruncated: false,
        stderrTruncated: false,
        durationMs: 10,
        images: [{
          mimeType: "image/png" as const,
          data: generatedImageData,
          alt: "oee-ranking",
          referenceName: "oee-ranking",
        }],
      },
    }),
  } as unknown as CodeInterpreterRuntime;
  const toolsWithCode = createAgentTools(database, artifacts, availableRuntime) as readonly CallableTool[];
  const codeInterpreter = toolsWithCode.find((tool) => tool.name === "code_interpreter");
  assert.ok(codeInterpreter);
  assert.match(codeInterpreter.description, /pre-injected global functions, not Python modules/u);
  assert.match(codeInterpreter.description, /never import either name/u);
  assert.match(
    codeInterpreter.description,
    /fontproperties=matplotlib_chinese_font\(12, bold=True\)/u,
  );
  assert.match(codeInterpreter.description, /font=chinese_font\(20, bold=True\)/u);
  const codeResult = await codeInterpreter.execute(
    "code/call",
    { code: "pass" },
    undefined,
    undefined,
    undefined as never,
  );
  const codeText = codeResult.content[0]?.text ?? "{}";
  const codePayload = JSON.parse(codeText) as Record<string, unknown>;
  assert.deepEqual(codePayload["imageReferences"], [{
    id: "ci-oee-ranking",
    markdown: "![oee-ranking](/__datalens_generated_image__/ci-oee-ranking)",
  }]);
  assert.deepEqual(
    (codeResult.details as { images: Array<{ referenceId: string }> }).images[0]?.referenceId,
    "ci-oee-ranking",
  );
  assert.equal(codeText.includes(generatedImageData), false);

  const repeated = await codeInterpreter.execute(
    "another-long-tool-call-id",
    { code: "pass" },
    undefined,
    undefined,
    undefined as never,
  );
  const repeatedPayload = JSON.parse(repeated.content[0]?.text ?? "{}") as Record<string, unknown>;
  assert.deepEqual(repeatedPayload["imageReferences"], [{
    id: "ci-oee-ranking-2",
    markdown: "![oee-ranking](/__datalens_generated_image__/ci-oee-ranking-2)",
  }]);

  const restoredTools = createAgentTools(
    database,
    artifacts,
    availableRuntime,
    new Set(["ci-oee-ranking", "ci-oee-ranking-2"]),
  ) as readonly CallableTool[];
  const restoredCodeInterpreter = restoredTools.find((tool) => tool.name === "code_interpreter");
  assert.ok(restoredCodeInterpreter);
  const restored = await restoredCodeInterpreter.execute(
    "restored-tool-call",
    { code: "pass" },
    undefined,
    undefined,
    undefined as never,
  );
  const restoredPayload = JSON.parse(restored.content[0]?.text ?? "{}") as Record<string, unknown>;
  assert.deepEqual(restoredPayload["imageReferences"], [{
    id: "ci-oee-ranking-3",
    markdown: "![oee-ranking](/__datalens_generated_image__/ci-oee-ranking-3)",
  }]);
});
