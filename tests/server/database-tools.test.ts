import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { initializeOeeDatabase } from "../../scripts/database/initialize.ts";
import { ArtifactStore } from "../../src/server/agent/artifact-store.ts";
import { CodeInterpreterRuntime } from "../../src/server/agent/code-interpreter.ts";
import { createAgentTools } from "../../src/server/agent/database-tools.ts";
import { AppDatabase } from "../../src/server/data/database.ts";

interface ToolResult {
  readonly content: readonly { readonly type: string; readonly text?: string }[];
  readonly details: unknown;
}

interface CallableTool {
  readonly name: string;
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
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, "oee.sqlite");
  initializeOeeDatabase(filePath);
  const database = AppDatabase.open({ filePath });
  t.after(() => database.close());
  const runtime = await CodeInterpreterRuntime.create({
    pythonPath: path.join(directory, "missing-python"),
    bwrapPath: path.join(directory, "missing-bwrap"),
    prlimitPath: path.join(directory, "missing-prlimit"),
    projectRoot: directory,
  });
  t.after(() => runtime.dispose());
  const artifacts = new ArtifactStore(path.join(directory, "artifacts"))
    .forSession("session-12345678");
  const tools = createAgentTools(database, artifacts, runtime) as readonly CallableTool[];
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
});
