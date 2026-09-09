import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { initializeOeeDatabase } from "../../scripts/database/initialize.ts";
import { ArtifactStore } from "../../src/server/tool/artifact-store.ts";
import {
  CodeInterpreterRuntime,
  type CodeInterpreterInput,
} from "../../src/server/tool/code-interpreter.ts";
import { createAgentTools } from "../../src/server/tool/database-tools.ts";
import { AppDatabase } from "../../src/server/database/database.ts";

interface ToolResult {
  readonly content: readonly { readonly type: string; readonly text?: string }[];
  readonly details: unknown;
}

interface CallableTool {
  readonly name: string;
  readonly description: string;
  readonly parameters: Record<string, unknown>;
  execute(
    id: string,
    params: Record<string, unknown>,
    signal: AbortSignal | undefined,
    onUpdate: undefined,
    context: never,
  ): Promise<ToolResult>;
}

test("execute_sql saves logical snapshots and code_interpreter reuses frozen data", async (t) => {
  const directory = mkdtempSync(path.join(tmpdir(), "sqlite-qa-tools-"));
  const filePath = path.join(directory, "oee.sqlite");
  initializeOeeDatabase(filePath);
  const database = AppDatabase.open({ filePath });
  const artifactDirectory = path.join(directory, "artifacts");
  const artifacts = new ArtifactStore(artifactDirectory).forSession("session-12345678");
  let runtime: CodeInterpreterRuntime | undefined;
  t.after(() => {
    runtime?.dispose();
    database.close();
    rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  runtime = await CodeInterpreterRuntime.create({
    pythonPath: path.join(directory, "missing-python"),
    bwrapPath: path.join(directory, "missing-bwrap"),
    prlimitPath: path.join(directory, "missing-prlimit"),
    projectRoot: directory,
  });
  const tools = createAgentTools(database, artifacts, runtime) as readonly CallableTool[];
  assert.deepEqual(tools.map((tool) => tool.name), ["execute_sql", "get_current_time"]);
  const executeSql = tools.find((tool) => tool.name === "execute_sql");
  assert.ok(executeSql);
  assert.equal(JSON.stringify(executeSql.parameters).includes("output_format"), false);

  const inline = await executeSql.execute("inline", {
    sql: "WITH RECURSIVE numbers(value) AS (VALUES(1) UNION ALL SELECT value + 1 FROM numbers WHERE value < 201) SELECT value FROM numbers",
  }, undefined, undefined, undefined as never);
  const inlineResult = JSON.parse(inline.content[0]?.text ?? "{}") as Record<string, unknown>;
  assert.equal(inlineResult["rowCount"], 200);
  assert.equal(inlineResult["truncated"], true);
  await assert.rejects(
    () => executeSql.execute(
      "invalid-limit",
      { sql: "SELECT 1", limit: 201 },
      undefined,
      undefined,
      undefined as never,
    ),
    /不能超过 200/u,
  );
  await assert.rejects(
    () => executeSql.execute(
      "legacy-file",
      { sql: "SELECT 1", output_format: "json_file" },
      undefined,
      undefined,
      undefined as never,
    ),
    /已移除 output_format/u,
  );

  const query = "SELECT COALESCE(SUM(time_span), 0) AS total FROM oee_availability";
  const saved = await executeSql.execute(
    "save-snapshot",
    { sql: query, save_as: "OEE 总计" },
    undefined,
    undefined,
    undefined as never,
  );
  const savedPayload = JSON.parse(saved.content[0]?.text ?? "{}") as {
    mode: string;
    snapshot: {
      name: string;
      version: string;
      rowCount: number;
      replaced: boolean;
    };
    preview: { rows: Array<Record<string, unknown>>; rowCount: number; truncated: boolean };
    pythonInput: { rows: string; rowShape: string; rowAccess: string };
  };
  assert.equal(savedPayload.mode, "snapshot");
  assert.equal(savedPayload.snapshot.name, "oee-总计");
  assert.equal(savedPayload.snapshot.rowCount, 1);
  assert.equal(savedPayload.snapshot.replaced, false);
  assert.deepEqual(savedPayload.preview.rows, [{ total: 0 }]);
  assert.deepEqual(savedPayload.pythonInput, {
    rows: "snapshot_rows",
    rowShape: "list[dict]",
    rowAccess: "row['column_name']",
  });
  assert.equal(JSON.stringify(savedPayload).includes("artifact://"), false);

  const many = await executeSql.execute(
    "preview-cap",
    {
      sql: "WITH RECURSIVE numbers(value) AS (VALUES(1) UNION ALL SELECT value + 1 FROM numbers WHERE value < 25) SELECT value FROM numbers",
      save_as: "Many Values",
      limit: 200,
    },
    undefined,
    undefined,
    undefined as never,
  );
  const manyPayload = JSON.parse(many.content[0]?.text ?? "{}") as {
    snapshot: { rowCount: number };
    preview: { rowCount: number; truncated: boolean };
  };
  assert.equal(manyPayload.snapshot.rowCount, 25);
  assert.equal(manyPayload.preview.rowCount, 20);
  assert.equal(manyPayload.preview.truncated, true);

  const generatedImageData = "PRIVATE_GENERATED_IMAGE_DATA";
  const mountedInputs: CodeInterpreterInput[] = [];
  const availableRuntime = {
    status: { available: true, reason: null },
    execute: async (_code: string, input: CodeInterpreterInput) => {
      mountedInputs.push(input);
      const databaseInput = input.snapshot === null
        ? null
        : JSON.parse(readFileSync(input.snapshot.databasePath, "utf8")) as {
          rows: Array<Record<string, unknown>>;
        };
      const total = databaseInput?.rows[0]?.["total"] ?? null;
      return {
        text: "runtime result",
        details: {
          kind: "code_interpreter" as const,
          result: {
            summary: input.snapshot === null ? "pure python" : "database total",
            metrics: { total },
          },
          provenance: {
            source: input.snapshot === null ? "none" as const : "sqlite" as const,
            snapshotName: input.snapshot?.name ?? null,
            snapshotVersion: input.snapshot?.version ?? null,
            snapshotCreatedAt: input.snapshot?.createdAt ?? null,
            rowCount: input.snapshot?.rowCount ?? 0,
            byteCount: input.snapshot?.byteCount ?? 0,
            truncated: false as const,
            hasUserInput: input.userInput !== null,
          },
          stdout: "rendered\n",
          stderr: "",
          stdoutTruncated: false,
          stderrTruncated: false,
          durationMs: 10,
          images: input.snapshot === null
            ? []
            : [{
              mimeType: "image/png" as const,
              data: generatedImageData,
              alt: "oee-ranking",
              referenceName: "oee-ranking",
            }],
        },
      };
    },
  } as unknown as CodeInterpreterRuntime;
  const toolsWithCode = createAgentTools(
    database,
    artifacts,
    availableRuntime,
  ) as readonly CallableTool[];
  const codeInterpreter = toolsWithCode.find((tool) => tool.name === "code_interpreter");
  assert.ok(codeInterpreter);
  const schemaText = JSON.stringify(codeInterpreter.parameters);
  assert.match(JSON.stringify(executeSql.parameters), /"save_as"/u);
  assert.match(schemaText, /"snapshot"/u);
  assert.match(schemaText, /"user_input"/u);
  assert.equal(schemaText.includes("query"), false);
  assert.equal(schemaText.includes("input_json"), false);
  assert.match(codeInterpreter.description, /logical snapshot name/u);
  assert.match(codeInterpreter.description, /emit_result exactly once/u);

  await assert.rejects(
    () => codeInterpreter.execute(
      "old-call",
      { code: "pass", input_json: "{\"fake\":1}" },
      undefined,
      undefined,
      undefined as never,
    ),
    /已移除 input_json/u,
  );
  await assert.rejects(
    () => codeInterpreter.execute(
      "old-query",
      { code: "pass", query: { sql: "SELECT 1" } },
      undefined,
      undefined,
      undefined as never,
    ),
    /不再接收 query/u,
  );

  const code = "rows = input_data['database']['rows']";
  const first = await codeInterpreter.execute(
    "code/call",
    { code, snapshot: "OEE_总计", user_input: { weight: 0.75 } },
    undefined,
    undefined,
    undefined as never,
  );
  const firstPayload = JSON.parse(first.content[0]?.text ?? "{}") as Record<string, unknown>;
  assert.deepEqual((firstPayload["result"] as { metrics: unknown }).metrics, { total: 0 });
  assert.deepEqual(firstPayload["imageReferences"], [{
    id: "ci-oee-ranking",
    markdown: "![oee-ranking](/__datalens_generated_image__/ci-oee-ranking)",
  }]);
  assert.equal(
    (first.details as { images: Array<{ referenceId: string }> }).images[0]?.referenceId,
    "ci-oee-ranking",
  );
  assert.equal(firstPayload["stdout"], "rendered\n");
  assert.equal(JSON.stringify(firstPayload).includes(generatedImageData), false);
  assert.deepEqual(mountedInputs[0]?.userInput, { weight: 0.75 });
  assert.equal(mountedInputs[0]?.snapshot?.name, "oee-总计");
  const firstInputPath = mountedInputs[0]?.snapshot?.databasePath;
  assert.ok(firstInputPath);
  assert.equal(existsSync(firstInputPath), true);

  const writer = new DatabaseSync(filePath);
  writer.prepare(
    "INSERT INTO oee_availability(tool_name,lot_id,final_state,step,date,time_span) VALUES(?,?,?,?,?,?)",
  ).run("ADH001", "P1", "Test(Normal)", "5000", "2026-09-01", 42);
  writer.close();
  const second = await codeInterpreter.execute(
    "same-snapshot-old-data",
    { code, snapshot: "oee-总计" },
    undefined,
    undefined,
    undefined as never,
  );
  const secondPayload = JSON.parse(second.content[0]?.text ?? "{}") as {
    result: { metrics: { total: number } };
  };
  assert.equal(secondPayload.result.metrics.total, 0);
  assert.equal(mountedInputs[1]?.userInput, null);

  const refreshed = await executeSql.execute(
    "refresh-snapshot",
    { sql: query, save_as: "oee 总计" },
    undefined,
    undefined,
    undefined as never,
  );
  const refreshedPayload = JSON.parse(refreshed.content[0]?.text ?? "{}") as {
    snapshot: { version: string; replaced: boolean };
  };
  assert.equal(refreshedPayload.snapshot.replaced, true);
  assert.notEqual(refreshedPayload.snapshot.version, savedPayload.snapshot.version);
  assert.equal(existsSync(firstInputPath), false);
  const third = await codeInterpreter.execute(
    "refreshed-data",
    { code, snapshot: "oee-总计" },
    undefined,
    undefined,
    undefined as never,
  );
  const thirdPayload = JSON.parse(third.content[0]?.text ?? "{}") as {
    result: { metrics: { total: number } };
  };
  assert.equal(thirdPayload.result.metrics.total, 42);

  const pure = await codeInterpreter.execute(
    "pure-python",
    { code: "emit_result({'summary':'pure'})" },
    undefined,
    undefined,
    undefined as never,
  );
  const purePayload = JSON.parse(pure.content[0]?.text ?? "{}") as {
    provenance: { source: string; snapshotName: string | null };
  };
  assert.equal(purePayload.provenance.source, "none");
  assert.equal(purePayload.provenance.snapshotName, null);
  assert.equal(mountedInputs.at(-1)?.snapshot, null);

  await assert.rejects(
    () => codeInterpreter.execute(
      "missing-snapshot",
      { code, snapshot: "does-not-exist" },
      undefined,
      undefined,
      undefined as never,
    ),
    /可用快照：many-values、oee-总计/u,
  );

  const callsBeforeTruncation = mountedInputs.length;
  const versionBeforeTruncation = artifacts.resolveDataSnapshot("oee-总计").version;
  const cancelled = new AbortController();
  cancelled.abort();
  await assert.rejects(
    () => executeSql.execute(
      "cancelled-refresh",
      { sql: query, save_as: "oee-总计" },
      cancelled.signal,
      undefined,
      undefined as never,
    ),
    (error) => error instanceof Error && error.name === "AbortError",
  );
  assert.equal(artifacts.resolveDataSnapshot("oee-总计").version, versionBeforeTruncation);
  await assert.rejects(
    () => executeSql.execute(
      "truncated",
      {
        sql: "WITH RECURSIVE numbers(value) AS (VALUES(1) UNION ALL SELECT value + 1 FROM numbers WHERE value <= 100000) SELECT value FROM numbers",
        save_as: "oee-总计",
      },
      undefined,
      undefined,
      undefined as never,
    ),
    /行数上限被截断/u,
  );
  assert.equal(mountedInputs.length, callsBeforeTruncation);
  assert.equal(artifacts.resolveDataSnapshot("oee-总计").version, versionBeforeTruncation);
  assert.equal(readdirSync(path.join(artifactDirectory, "session-12345678")).includes("snapshots.json"), true);

  const restoredTools = createAgentTools(
    database,
    artifacts,
    availableRuntime,
    new Set(["ci-oee-ranking", "ci-oee-ranking-2", "ci-oee-ranking-3"]),
  ) as readonly CallableTool[];
  const restoredCodeInterpreter = restoredTools.find((tool) => tool.name === "code_interpreter");
  assert.ok(restoredCodeInterpreter);
  const restored = await restoredCodeInterpreter.execute(
    "restored-tool-call",
    { code, snapshot: "oee-总计" },
    undefined,
    undefined,
    undefined as never,
  );
  const restoredPayload = JSON.parse(restored.content[0]?.text ?? "{}") as Record<string, unknown>;
  assert.deepEqual(restoredPayload["imageReferences"], [{
    id: "ci-oee-ranking-4",
    markdown: "![oee-ranking](/__datalens_generated_image__/ci-oee-ranking-4)",
  }]);
});
