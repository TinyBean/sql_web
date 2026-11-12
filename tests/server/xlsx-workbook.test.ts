import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test, { before, after, type TestContext } from "node:test";
import { CodeInterpreterRuntime } from "../../src/server/tool/code-interpreter.ts";
import { ArtifactStore } from "../../src/server/tool/artifact-store.ts";
import { createExcelSkillContext, saveUploadedWorkbook, validateUploadedWorkbook } from "../../src/server/agent/xlsx-skill-runtime.ts";
import { createTools } from "../../src/server/skills/xlsx/assets/tools.ts";
import type { WorkbookOperation } from "../../src/server/skills/xlsx/assets/runtime.ts";

let runtime: CodeInterpreterRuntime;
before(async () => {
  runtime = await CodeInterpreterRuntime.create({ projectRoot: process.cwd(), pythonPath: "/usr/bin/python3", bwrapPath: "/usr/bin/bwrap", prlimitPath: "/usr/bin/prlimit" });
  assert.equal(runtime.status.available, true);
  assert.equal((await runtime.checkXlsxSupport()).available, true);
});
after(() => runtime.dispose());

function python(code: string, ...args: string[]): string {
  const result = spawnSync("/usr/bin/python3", ["-c", "import sys,json\nsys.path.insert(0,sys.argv[1])\n" + code, path.join(process.cwd(), ".data/xlsx-python"), ...args], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}
function fixture(t: TestContext) {
  const root = mkdtempSync(path.join(tmpdir(), "xlsx-edit-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const filename = path.join(root, "original.xlsx");
  python("from openpyxl import Workbook\nfrom openpyxl.styles import Font\nw=Workbook()\ns=w.active\ns.title='数据'\ns.append(['编号','数值','公式'])\ns.append(['0007',1.234567,'=B2*2'])\ns['A4']='保留合并'\ns.merge_cells('A4:B4')\ns['F5']='未修改'\ns['F5'].font=Font(name='Arial',italic=True,color='123456')\ns.freeze_panes='A2'\ns.auto_filter.ref='A1:C2'\nw.create_sheet('第二页')['A1']='中文'\nw.save(sys.argv[2])", filename);
  const bytes = readFileSync(filename);
  const artifacts = new ArtifactStore(path.join(root, "artifacts")).forSession("session-12345678");
  const files = artifacts.exportFiles();
  const events: string[] = [];
  const context = createExcelSkillContext(artifacts, runtime, { info(event) { events.push(event); }, error(event) { events.push(event); } });
  return { root, filename, bytes, artifacts, files, context, events };
}

test("uploads original bytes, inspects sheets and regions, edits a new version with summary and preserves unrelated workbook content", async (t) => {
  const env = fixture(t);
  await validateUploadedWorkbook(runtime, "原始表.xlsx", env.bytes);
  const uploaded = saveUploadedWorkbook(env.artifacts, "原始表.xlsx", env.bytes);
  assert.equal(uploaded.kind, "upload");
  assert.deepEqual(env.files.read(uploaded.id).bytes, env.bytes);
  const overview = JSON.parse(JSON.stringify(await env.context.inspectWorkbook({ file_id: uploaded.id })));
  assert.deepEqual(overview.data.sheets.map((sheet: {name: string}) => sheet.name), ["数据", "第二页"]);
  assert.equal(overview.data.formula_count, 1);
  const preview = JSON.parse(JSON.stringify(await env.context.inspectWorkbook({ file_id: uploaded.id, sheet: "数据", range: "A2:C2" })));
  assert.deepEqual(preview.data.cells.map((cell: {value: unknown}) => cell.value), ["0007", 1.234567, "=B2*2"]);
  const operations: WorkbookOperation[] = [
    { type: "set", sheet: "数据", range: "A2:B2", values: [["0008", 0.123456789]] },
    { type: "set", sheet: "第二页", range: "A2:D2", values: [["=SUM(1,2)", "中文", null, 12.34]] },
    { type: "fill", sheet: "第二页", range: "A3:B4", value: "已核对" },
    { type: "format", sheet: "数据", range: "B2", style: { number_format: "ratio", bold: true, font_color: "FF0000", fill_color: "EEEEEE", alignment: "center", wrap_text: true, column_width: 22, row_height: 30 } },
    { type: "format", sheet: "第二页", range: "D2", style: { number_format: "percent" } },
  ];
  const edited = JSON.parse(JSON.stringify(await env.context.editWorkbook({ file_id: uploaded.id, operations })));
  assert.notEqual(edited.file_id, uploaded.id);
  assert.equal(edited.parent_file_id, uploaded.id);
  assert.equal(edited.metrics.value_cells, 10);
  assert.equal(edited.metrics.format_cells, 2);
  assert.match(edited.data.notes[0], /不计算公式/u);
  const output = env.files.read(edited.file_id);
  assert.match(output.metadata.summary!, /第二页!A3:B4：填充/u);
  const modifiedPath = path.join(env.root, "modified.xlsx");
  writeFileSync(modifiedPath, output.bytes);
  const verified = JSON.parse(python(`from openpyxl import load_workbook
w=load_workbook(sys.argv[2],data_only=False)
s=w['数据']; t=w['第二页']
assert w.sheetnames==['数据','第二页']
assert s['A2'].value=='0008' and s['B2'].value==0.123456789
assert s['C2'].value=='=B2*2' and s['C2'].data_type=='f'
assert str(s.merged_cells)=='A4:B4' and s['A4'].value=='保留合并'
assert s['F5'].value=='未修改' and s['F5'].font.italic and s['F5'].font.color.rgb=='00123456'
assert s.freeze_panes=='A2' and s.auto_filter.ref=='A1:C2'
assert s['B2'].font.bold and s['B2'].font.color.rgb=='00FF0000'
assert s['B2'].fill.fgColor.rgb=='00EEEEEE' and s['B2'].number_format=='0.00%'
assert s['B2'].alignment.wrap_text and s['B2'].alignment.horizontal=='center'
assert s.column_dimensions['B'].width==22 and s.row_dimensions[2].height==30
assert t['A2'].value=='=SUM(1,2)' and t['A2'].data_type=='s'
assert t['C2'].value is None and t['D2'].number_format=='0.00"%"'
assert all(t.cell(r,c).value=='已核对' for r in [3,4] for c in [1,2])
print(json.dumps({'ok': True}))`, modifiedPath));
  assert.equal(verified.ok, true);
  assert.deepEqual(env.files.read(uploaded.id).bytes, env.bytes);
  assert.equal(env.context.listFiles().length, 2);
  assert.ok(env.events.includes("xlsx.edit.completed"));
});

test("invalid edits, ranges, cancellation and invalid IDs publish no new files", async (t) => {
  const env = fixture(t);
  const file = saveUploadedWorkbook(env.artifacts, "test.xlsx", env.bytes);
  const invalid: WorkbookOperation[][] = [
    [{ type: "fill", sheet: "missing", range: "A1", value: 1 }],
    [{ type: "fill", sheet: "数据", range: "B4", value: 1 }],
    [{ type: "fill", sheet: "数据", range: "A:A", value: 1 }],
    [{ type: "fill", sheet: "数据", range: "A1:A10001", value: 1 }],
    [{ type: "fill", sheet: "数据", range: "XFE1", value: 1 }],
    [{ type: "set", sheet: "数据", range: "A1:B1", values: [[1]] }],
    [{ type: "fill", sheet: "数据", range: "A2", value: "临时" }, { type: "fill", sheet: "数据", range: "B4", value: "错误" }],
  ];
  for (const operations of invalid) await assert.rejects(env.context.editWorkbook({ file_id: file.id, operations }));
  await assert.rejects(env.context.inspectWorkbook({ file_id: file.id, sheet: "数据", range: "A1:A201" }));
  await assert.rejects(env.context.inspectWorkbook({ file_id: file.id, sheet: "数据" }));
  await assert.rejects(env.context.inspectWorkbook({ file_id: "../workbook.xlsx" }));
  const abort = new AbortController(); abort.abort();
  await assert.rejects(env.context.editWorkbook({ file_id: file.id, operations: [{ type: "fill", sheet: "数据", range: "A2", value: 2 }] }, abort.signal));
  const foreign = new ArtifactStore(path.join(env.root, "artifacts")).forSession("session-87654321");
  const other = createExcelSkillContext(foreign, runtime, { info() {}, error() {} });
  await assert.rejects(other.inspectWorkbook({ file_id: file.id }), /不存在或不可访问/u);
  assert.equal(env.files.list().length, 1);
  assert.deepEqual(env.files.read(file.id).bytes, env.bytes);
});

test("rejects fake, macro, unsafe XML, expansion and unsupported object packages before publication", async (t) => {
  const env = fixture(t);
  await assert.rejects(validateUploadedWorkbook(runtime, "macro.xlsm", env.bytes), /xlsx/u);
  await assert.rejects(validateUploadedWorkbook(runtime, "bad.xlsx", Buffer.from("not a zip")));
  await assert.rejects(validateUploadedWorkbook(runtime, "huge.xlsx", Buffer.alloc(8 * 1024 * 1024 + 1)));
  for (const [name, value] of [
    ["xl/vbaProject.bin", "macro"], ["xl/drawings/drawing1.xml", "<x/>"],
    ["unsafe.xml", '<!DOCTYPE x [<!ENTITY a "expanded">]><x>&a;</x>'],
    ["../escape.xml", "<x/>"], ["xl/externalLinks/externalLink1.xml", "<x/>"],
  ]) {
    const modified = path.join(env.root, "bad.xlsx");
    python("import zipfile,shutil\nshutil.copyfile(sys.argv[2],sys.argv[3])\nwith zipfile.ZipFile(sys.argv[3],'a') as z: z.writestr(sys.argv[4],sys.argv[5])", env.filename, modified, name!, value!);
    await assert.rejects(validateUploadedWorkbook(runtime, "bad.xlsx", readFileSync(modified)));
  }
  const bomb = path.join(env.root, "bomb.xlsx");
  python("import zipfile,shutil\nshutil.copyfile(sys.argv[2],sys.argv[3])\nwith zipfile.ZipFile(sys.argv[3],'a',compression=zipfile.ZIP_DEFLATED) as z: z.writestr('xl/oversized.xml',b' '*(65*1024*1024))", env.filename, bomb);
  await assert.rejects(validateUploadedWorkbook(runtime, "bomb.xlsx", readFileSync(bomb)), /64 MiB/u);
  assert.equal(env.files.list().length, 0);
});

test("explicitly replacing a formula is summarized; new strings never become formulas", async (t) => {
  const env = fixture(t);
  const file = saveUploadedWorkbook(env.artifacts, "test.xlsx", env.bytes);
  const result = JSON.parse(JSON.stringify(await env.context.editWorkbook({ file_id: file.id,
    operations: [{ type: "fill", sheet: "数据", range: "C2", value: "=123" }] })));
  assert.equal(result.metrics.replaced_formulas, 1);
  assert.match(result.summary, /原有公式被替换/u);
  const read = JSON.parse(JSON.stringify(await env.context.inspectWorkbook({ file_id: result.file_id, sheet: "数据", range: "C2" })));
  assert.equal(read.data.formula_count, 0);
  assert.equal(read.data.cells[0].type, "s");
});

test("all workbook tools require the persistent main-session runtime context", async () => {
  for (const tool of createTools().filter((tool) => tool.name !== "export")) {
    await assert.rejects(tool.execute("test", {}, undefined, undefined, undefined as never), /仅支持持久化网页主会话/u);
  }
});

test("edit dependency failures, timeout, oversized output and in-flight cancellation never publish a version", async (t) => {
  const env = fixture(t);
  const original = saveUploadedWorkbook(env.artifacts, "test.xlsx", env.bytes);
  const input = { file_id: original.id, operations: [{ type: "fill" as const, sheet: "数据", range: "A2", value: "new" }] };
  for (const message of ["openpyxl 不可用", "Python 执行超过 15 秒，已终止"]) {
    const failed = { async processWorkbook() { throw new Error(message); } } as unknown as CodeInterpreterRuntime;
    const context = createExcelSkillContext(env.artifacts, failed, { info() {}, error() {} });
    await assert.rejects(context.editWorkbook(input), { message });
  }
  const bytes = Buffer.alloc(8 * 1024 * 1024 + 1); bytes.writeUInt32LE(0x04034b50);
  const oversized = { async processWorkbook() { return { workbook: bytes, details: { result: { summary: "edited", data: { changes: [] } } } }; } } as unknown as CodeInterpreterRuntime;
  await assert.rejects(createExcelSkillContext(env.artifacts, oversized, { info() {}, error() {} }).editWorkbook(input), /8 MiB/u);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("edit cancelled")), 20);
  try { await assert.rejects(env.context.editWorkbook(input, controller.signal), /cancel|取消/u); }
  finally { clearTimeout(timer); }
  assert.equal(env.files.list().length, 1);
  assert.deepEqual(env.files.read(original.id).bytes, env.bytes);
});
