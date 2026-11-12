import assert from "node:assert/strict";
import { closeSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test, { after, before, type TestContext } from "node:test";
import { CodeInterpreterRuntime } from "../../src/server/tool/code-interpreter.ts";
import { ArtifactStore } from "../../src/server/tool/artifact-store.ts";
import { ExportFileNotFoundError, MAX_EXCEL_BYTES, SessionExportFiles } from "../../src/server/tool/export-files.ts";
import { createExcelSkillContext } from "../../src/server/agent/xlsx-skill-runtime.ts";
import { createAgentTools } from "../../src/server/tool/database-tools.ts";
import { createTools } from "../../src/server/skills/xlsx/assets/tools.ts";
import { AppDatabase } from "../../src/server/database/database.ts";
import { initializeOeeDatabase } from "../../scripts/database/initialize.ts";

const projectRoot = process.cwd();
const logger = { info() {}, error() {} };
let runtime: CodeInterpreterRuntime;
before(async () => {
  runtime = await CodeInterpreterRuntime.create({ projectRoot, pythonPath: "/usr/bin/python3", bwrapPath: "/usr/bin/bwrap", prlimitPath: "/usr/bin/prlimit" });
  assert.deepEqual(runtime.status, { available: true, reason: null });
  assert.deepEqual(await runtime.checkXlsxSupport(), { available: true, reason: null });
});
after(() => runtime.dispose());

function fixture(t: TestContext) {
  const root = mkdtempSync(path.join(tmpdir(), "xlsx-export-test-"));
  const artifacts = new ArtifactStore(path.join(root, "artifacts")).forSession("session-12345678");
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const files = artifacts.exportFiles();
  const context = createExcelSkillContext(artifacts, runtime, logger);
  const save = (rows: Record<string, unknown>[], columns = ["value"], truncated = false) => artifacts.createDataSnapshot("values", (fd) => {
    writeSync(fd, JSON.stringify({ columns, rows, rowCount: rows.length, truncated }));
    return { columns, rowCount: rows.length };
  });
  return { root, artifacts, files, context, save };
}

function workbookInfo(filename: string) {
  const result = spawnSync("/usr/bin/python3", ["-c", [
    "import sys,json", "sys.path.insert(0,sys.argv[2])", "from openpyxl import load_workbook",
    "w=load_workbook(sys.argv[1],data_only=False)", "s=w['数据']",
    "print(json.dumps({'sheets':w.sheetnames,'values':list(s.values),'formats':[[c.number_format for c in r] for r in s],'types':[[c.data_type for c in r] for r in s],'freeze':s.freeze_panes,'filter':s.auto_filter.ref,'font':s['A1'].font.name,'fill':s['A1'].fill.fgColor.rgb,'notes':list(w['说明'].values)},ensure_ascii=False))",
  ].join("\n"), filename, path.join(projectRoot, ".data/xlsx-python")], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

test("exports the full SQL snapshot, formats values and preserves identifiers, nulls and literal text", async (t) => {
  const env = fixture(t);
  const databasePath = path.join(env.root, "oee.sqlite");
  initializeOeeDatabase(databasePath);
  const database = AppDatabase.open({ filePath: databasePath });
  t.after(() => database.close());
  const sql = createAgentTools(database, env.artifacts, runtime).find((tool) => tool.name === "execute_sql")!;
  const saved = await sql.execute("query", { sql: "WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<35) SELECT x, '0007' AS machine, 0.123456 AS oee, 12.3456 AS oee_percent, NULL AS missing, '=SUM(A1:A2)' AS label, '2026-11-12' AS date FROM n", save_as: "values", limit: 1 }, undefined, undefined, undefined as never);
  assert.equal(JSON.parse((saved.content[0] as { text: string }).text).snapshot.rowCount, 35);
  const tool = createTools(env.context)[0]!;
  const result = await tool.execute("export", { snapshot: "values", filename: "中文报表.xlsx", title: "MT/ST 查询结果", description: "业务日 2026-11-12", columns: [
    { key: "x", title: "序号" }, { key: "machine", title: "机台", format: "text" },
    { key: "oee", format: "ratio" }, { key: "oee_percent", format: "percent" },
    { key: "missing" }, { key: "label" }, { key: "date" },
  ] }, undefined, undefined, undefined as never);
  const output = JSON.parse((result.content[0] as { text: string }).text);
  assert.equal(output.row_count, 35);
  assert.equal(output.filename, "中文报表.xlsx");
  assert.equal(output.download_url, `/api/sessions/session-12345678/files/${output.file_id}`);
  const file = env.files.open(output.file_id);
  assert.equal(readFileSync(file.fd).length, output.byte_count);
  closeSync(file.fd);
  const info = workbookInfo(path.join(env.root, "artifacts/session-12345678/exports", output.file_id, "workbook.xlsx"));
  assert.deepEqual(info.sheets, ["数据", "说明"]);
  assert.equal(info.values.length, 36);
  assert.deepEqual(info.values[1], [1, "0007", 0.123456, 12.3456, null, "=SUM(A1:A2)", "2026-11-12"]);
  assert.deepEqual(info.formats[1].slice(0, 4), ["#,##0", "@", "0.00%", '0.00"%"']);
  assert.equal(info.types[1][5], "s");
  assert.ok(info.types.flat().every((value: string) => value !== "f"));
  assert.equal(info.freeze, "A2");
  assert.equal(info.filter, "A1:G36");
  assert.equal(info.font, "Arial");
  assert.ok(info.notes.some((row: unknown[]) => row[1] === "业务日 2026-11-12"));
  const originalVersion = file.metadata.source.version;
  env.save([{ value: 99 }]);
  const reopened = new SessionExportFiles(path.join(env.root, "artifacts"), "session-12345678").open(output.file_id);
  assert.equal(reopened.metadata.source.version, originalVersion);
  closeSync(reopened.fd);
});

test("exports empty snapshots and creates independent files for repeated exports", async (t) => {
  const env = fixture(t);
  env.save([]);
  const first = await env.context.exportSnapshot({ snapshot: "values" });
  const second = await env.context.exportSnapshot({ snapshot: "values" });
  assert.notEqual(first.file_id, second.file_id);
  const info = workbookInfo(path.join(env.root, "artifacts/session-12345678/exports", first.file_id, "workbook.xlsx"));
  assert.deepEqual(info.values, [["value"]]);
  assert.ok(info.notes.some((row: unknown[]) => row[1] === "无数据"));
  assert.equal(first.row_count, 0);
});

test("rejects invalid columns, truncated snapshots, oversized cells and cancellation without publishing", async (t) => {
  const env = fixture(t);
  env.save([{ value: 1 }]);
  await assert.rejects(env.context.exportSnapshot({ snapshot: "values", columns: [{ key: "missing" }] }), /导出列无效/u);
  await assert.rejects(env.context.exportSnapshot({ snapshot: "values", columns: [{ key: "value" }, { key: "value" }] }), /导出列无效/u);
  env.save([{ value: 1 }], ["value"], true);
  await assert.rejects(env.context.exportSnapshot({ snapshot: "values" }), /未截断/u);
  env.save([{ value: "x".repeat(32768) }]);
  await assert.rejects(env.context.exportSnapshot({ snapshot: "values" }), /单元格长度上限/u);
  env.save([{ value: "001" }]);
  await assert.rejects(env.context.exportSnapshot({ snapshot: "values", columns: [{ key: "value", format: "ratio" }] }), /数值列/u);
  await assert.rejects(env.context.exportSnapshot({ snapshot: "values" }, AbortSignal.abort(new Error("cancelled"))), /cancelled/u);
  assert.equal(existsSync(path.join(env.root, "artifacts/session-12345678/exports")), false);
});

test("runtime failures and 8 MiB limit leave no published or staged files", async (t) => {
  const env = fixture(t);
  env.save([{ value: 1 }]);
  for (const reason of ["openpyxl 不可用", "Python 执行超过 15 秒，已终止", "已取消"]) {
    const failedRuntime = { async exportWorkbook() { throw new Error(reason); } } as unknown as CodeInterpreterRuntime;
    const context = createExcelSkillContext(env.artifacts, failedRuntime, logger);
    await assert.rejects(context.exportSnapshot({ snapshot: "values" }), { message: reason });
  }
  const bytes = Buffer.alloc(MAX_EXCEL_BYTES + 1);
  bytes.writeUInt32LE(0x04034b50);
  assert.throws(() => env.files.save(bytes, { filename: "big.xlsx", rowCount: 1,
    source: { name: "values", version: "v1", createdAt: new Date().toISOString() } }), /8 MiB/u);
  assert.equal(existsSync(path.join(env.root, "artifacts/session-12345678/exports")), false);
});

test("rejects traversal, unregistered files, symlinks and corrupt metadata", async (t) => {
  const env = fixture(t);
  env.save([{ value: 1 }]);
  const output = await env.context.exportSnapshot({ snapshot: "values" });
  const directory = path.join(env.root, "artifacts/session-12345678/exports", output.file_id);
  assert.throws(() => env.files.open("../snapshots.json"), ExportFileNotFoundError);
  assert.throws(() => env.files.open("00000000-0000-4000-8000-000000000000"), ExportFileNotFoundError);
  const original = readFileSync(path.join(directory, "workbook.xlsx"));
  const outside = path.join(env.root, "outside.xlsx");
  writeFileSync(outside, original);
  rmSync(path.join(directory, "workbook.xlsx"));
  symlinkSync(outside, path.join(directory, "workbook.xlsx"));
  assert.throws(() => env.files.open(output.file_id), ExportFileNotFoundError);
  rmSync(path.join(directory, "workbook.xlsx"));
  writeFileSync(path.join(directory, "workbook.xlsx"), original);
  writeFileSync(path.join(directory, "metadata.json"), "{}");
  assert.throws(() => env.files.open(output.file_id), ExportFileNotFoundError);
  assert.ok(readdirSync(path.dirname(directory)).every((name) => !name.endsWith(".tmp")));
});

test("unbound skill tools cannot export in subagents, anonymous chat or daily analysis", async () => {
  const tool = createTools()[0]!;
  await assert.rejects(tool.execute("export", { snapshot: "values" }, undefined, undefined, undefined as never), /仅支持持久化网页主会话/u);
});

test("missing Excel dependency is isolated from normal Python and SQL availability", async (t) => {
  const env = fixture(t);
  const dependencies = path.join(env.root, ".data/xlsx-python");
  mkdirSync(dependencies, { recursive: true });
  writeFileSync(path.join(dependencies, "openpyxl.py"), "raise ImportError('dependency unavailable for test')\n");
  const isolated = await CodeInterpreterRuntime.create({ projectRoot: env.root, pythonPath: "/usr/bin/python3", bwrapPath: "/usr/bin/bwrap", prlimitPath: "/usr/bin/prlimit" });
  t.after(() => isolated.dispose());
  assert.equal(isolated.status.available, true);
  const status = await isolated.checkXlsxSupport();
  assert.equal(status.available, false);
  assert.match(status.reason!, /openpyxl/u);
  const normal = await isolated.execute("emit_result(metrics={'value': 42})", { snapshot: null, userInput: null }, undefined);
  assert.equal(normal.details.result.metrics?.["value"], 42);
  env.save([{ value: 1 }]);
  await assert.rejects(createExcelSkillContext(env.artifacts, isolated, logger).exportSnapshot({ snapshot: "values" }), /openpyxl/u);
  assert.equal(existsSync(path.join(env.root, "artifacts/session-12345678/exports")), false);
});

test("cancelling a running workbook export publishes no file", async (t) => {
  const env = fixture(t);
  env.save(Array.from({ length: 10000 }, (_, value) => ({ value })));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("export cancelled")), 20);
  try {
    await assert.rejects(env.context.exportSnapshot({ snapshot: "values" }, controller.signal), /export cancelled/u);
  } finally { clearTimeout(timer); }
  assert.equal(existsSync(path.join(env.root, "artifacts/session-12345678/exports")), false);
});
