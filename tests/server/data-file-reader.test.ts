import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { loadAgentSkillCatalog } from "../../src/server/agent/skill-catalog.ts";
import { MAX_DATA_READ_BYTES, type DataReadParameters } from "../../src/server/agent/data-file-reader.ts";

async function fixture(t: TestContext) {
  const root = mkdtempSync(path.join(tmpdir(), "sql-web-data-read-"));
  const skills = path.join(root, "skills");
  const skill = path.join(skills, "fixture");
  const data = path.join(root, ".data");
  mkdirSync(skill, { recursive: true });
  mkdirSync(data);
  writeFileSync(path.join(skill, "SKILL.md"), "---\nname: fixture\ndescription: Read fixture for data access and activation tests.\n---\n\n# Fixture\n");
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const catalog = await loadAgentSkillCatalog({ directory: skills });
  const session = async (enabled = false) => {
    const tools = new Map<string, ToolDefinition>();
    const entries: unknown[] = [];
    const extension = catalog.createSessionExtension(root, { readDataDirectory: enabled });
    await (typeof extension === "function" ? extension : extension.factory)({
      registerTool: (tool: ToolDefinition) => tools.set(tool.name, tool), on() {},
      getActiveTools: () => ["read"], setActiveTools() {}, appendEntry: (...entry: unknown[]) => entries.push(entry),
    } as never);
    return { entries, read: (filename: string, params: DataReadParameters = {}, signal?: AbortSignal) =>
      tools.get("read")!.execute("fixture", { path: filename, ...params }, signal, undefined, undefined as never)
        .then((result) => ({ ...result, details: result.details as Record<string, unknown> })) };
  };
  return { root, data, skill, session, website: await session(true) };
}

test("data access is opt-in and data SKILL.md does not activate tools", async (t) => {
  const { data, skill, website, session } = await fixture(t);
  const filename = path.join(data, "SKILL.md");
  writeFileSync(filename, "data is not a skill");
  const dailyParent = await session();
  const dailyChild = await session();
  for (const daily of [dailyParent, dailyChild]) await assert.rejects(daily.read(filename), /仅允许访问已扫描/u);
  assert.equal((await website.read(filename)).content[0]?.type, "text");
  assert.equal(website.entries.length, 0);
  await website.read(path.join(skill, "SKILL.md"));
  assert.equal(website.entries.length, 1);
  const websiteChild = await session(true);
  assert.deepEqual((await websiteChild.read(filename)).content, [{ type: "text", text: "data is not a skill" }]);
  assert.equal(websiteChild.entries.length, 0);
});

test("read rejects directories, outside files, sibling-prefix paths and symlink escapes", async (t) => {
  const { root, data, skill, website } = await fixture(t);
  const outside = path.join(root, "outside.txt");
  writeFileSync(outside, "outside");
  mkdirSync(path.join(root, ".data-other"));
  writeFileSync(path.join(root, ".data-other", "file.log"), "outside");
  symlinkSync(outside, path.join(data, "escape.log"));
  symlinkSync(path.join(skill, "SKILL.md"), path.join(data, "skill-alias.md"));
  for (const filename of [outside, ".data/../outside.txt", ".data-other/file.log", ".data/escape.log", ".data/skill-alias.md"]) {
    await assert.rejects(website.read(filename), /仅允许|符号链接逃逸/u);
  }
  await assert.rejects(website.read(data), /普通文件/u);
  await assert.rejects(website.read(".data/missing.log"), /文件不存在/u);
  rmSync(data, { recursive: true });
  symlinkSync(root, data, "dir");
  await assert.rejects(website.read(".data/outside.txt"), /符号链接逃逸/u);
});

test("raw UTF-8 paging preserves bytes, Chinese boundaries and long single lines", async (t) => {
  const { data, website } = await fixture(t);
  const filename = path.join(data, "large.log");
  const original = "前缀\n" + "中文😀".repeat(20_000) + "\n末尾\n";
  writeFileSync(filename, original);
  let offset = 0;
  let collected = "";
  let pages = 0;
  do {
    const result = await website.read(filename, { byte_offset: offset });
    const text = (result.content[0] as { text: string }).text;
    const details = result.details as { returnedBytes: number; truncated: boolean; nextByteOffset: number | null };
    assert.ok(Buffer.byteLength(text) <= MAX_DATA_READ_BYTES);
    assert.equal(Buffer.byteLength(text), details.returnedBytes);
    assert.ok(!text.includes("�"));
    collected += text;
    pages++;
    if (!details.truncated) { assert.equal(details.nextByteOffset, null); break; }
    assert.ok(details.nextByteOffset! > offset);
    offset = details.nextByteOffset!;
  } while (pages < 20);
  assert.ok(pages > 1);
  assert.equal(collected, original);
  const line = await website.read(filename, { offset: 2, limit: 1 });
  assert.equal((line.content[0] as { text: string }).text, "中文😀".repeat(5120));
  assert.ok((line.details as { truncated: boolean }).truncated);
  await assert.rejects(website.read(filename, { byte_offset: 1 }), /UTF-8/u);
  await assert.rejects(website.read(filename, { byte_offset: 0, offset: 1 }), /互斥/u);
  await assert.rejects(website.read(filename, { byte_offset: 0, limit: 2 }), /互斥/u);
  await assert.rejects(website.read(filename, { byte_offset: Buffer.byteLength(original) + 1 }), /超出/u);
});

test("line paging yields source byte cursors and supports empty or beyond-EOF reads", async (t) => {
  const { data, website } = await fixture(t);
  const filename = path.join(data, "lines.log");
  writeFileSync(filename, "一\r\n二\n三");
  const page = await website.read(filename, { offset: 2, limit: 1 });
  assert.equal((page.content[0] as { text: string }).text, "二\n");
  assert.equal((page.details as { nextByteOffset: number }).nextByteOffset, 9);
  const rest = await website.read(filename, { byte_offset: 9 });
  assert.equal((rest.content[0] as { text: string }).text, "三");
  assert.equal((await website.read(filename, { offset: 20 })).content[0]?.type, "text");
  writeFileSync(filename, "");
  assert.equal((await website.read(filename)).details?.["truncated"], false);
});

test("JSON Pointer locates large compact documents, escaped keys, arrays and null", async (t) => {
  const { data, website } = await fixture(t);
  const filename = path.join(data, "context.json");
  writeFileSync(filename, JSON.stringify({ unused: "x".repeat(2_600_000), periods: { day: { start: "2026-10-11", end: "2026-10-11" } }, "a/b": { "~": [null, "正确"] } }));
  const result = await website.read(filename, { json_pointer: "/periods/day" });
  assert.deepEqual(JSON.parse((result.content[0] as { text: string }).text), { start: "2026-10-11", end: "2026-10-11" });
  assert.equal(JSON.parse(((await website.read(filename, { json_pointer: "/a~1b/~0/0" })).content[0] as { text: string }).text), null);
  assert.equal(JSON.parse(((await website.read(filename, { json_pointer: "/a~1b/~0/1" })).content[0] as { text: string }).text), "正确");
  for (const pointer of ["periods", "/a~2b", "/missing", "/a~1b/~0/01", "/constructor"]) {
    await assert.rejects(website.read(filename, { json_pointer: pointer }), /Pointer/u);
  }
  await assert.rejects(website.read(filename, { json_pointer: "", offset: 1 }), /不使用 offset/u);
  await assert.rejects(website.read(filename, { json_pointer: "", limit: 1 }), /不使用 limit/u);
});

test("JSONL and structured logs select physical records and page projected values", async (t) => {
  const { data, website } = await fixture(t);
  for (const name of ["events.jsonl", "daily.log"]) {
    const filename = path.join(data, name);
    writeFileSync(filename, JSON.stringify({ status: "first" }) + "\n" + JSON.stringify({ fields: { status: "completed", large: "证据".repeat(60_000) } }) + "\n");
    const status = await website.read(filename, { offset: 2, json_pointer: "/fields/status" });
    assert.equal(JSON.parse((status.content[0] as { text: string }).text), "completed");
    assert.equal(status.details?.["recordLine"], 2);
    const first = await website.read(filename, { offset: 2, json_pointer: "/fields/large" });
    const chunks = [(first.content[0] as { text: string }).text];
    let next = first.details?.["nextByteOffset"] as number | null;
    while (next !== null) {
      const page = await website.read(filename, { offset: 2, json_pointer: "/fields/large", byte_offset: next });
      chunks.push((page.content[0] as { text: string }).text);
      next = page.details?.["nextByteOffset"] as number | null;
    }
    assert.equal(JSON.parse(chunks.join("")), "证据".repeat(60_000));
    await assert.rejects(website.read(filename, { offset: 3, json_pointer: "" }), /JSON 无效/u);
  }
});

test("binary, invalid UTF-8, incomplete JSON and oversized parsing are rejected", async (t) => {
  const { data, website } = await fixture(t);
  const filename = path.join(data, "invalid.json");
  writeFileSync(filename, Buffer.from([0x53, 0, 0x41]));
  await assert.rejects(website.read(filename), /二进制/u);
  writeFileSync(filename, Buffer.from([0xff, 0xfe]));
  await assert.rejects(website.read(filename), /UTF-8/u);
  writeFileSync(filename, '{"running":');
  await assert.rejects(website.read(filename, { json_pointer: "" }), /尚未写入完整/u);
  writeFileSync(filename, "x".repeat(32 * 1024 * 1024 + 1));
  await assert.rejects(website.read(filename, { json_pointer: "" }), /32 MiB/u);
  const records = path.join(data, "oversized.jsonl");
  writeFileSync(records, readFileSync(filename));
  await assert.rejects(website.read(records, { json_pointer: "" }), /32 MiB/u);
});

test("cancelled reads abort during scanning and allow subsequent reads", async (t) => {
  const { data, website } = await fixture(t);
  const filename = path.join(data, "scan.log");
  writeFileSync(filename, "line\n".repeat(600_000));
  const controller = new AbortController();
  const pending = website.read(filename, { offset: 500_000 }, controller.signal);
  setImmediate(() => controller.abort(new Error("cancelled read")));
  await assert.rejects(pending, /cancelled read/u);
  const preAborted = AbortSignal.abort(new Error("already cancelled"));
  await assert.rejects(website.read(filename, {}, preAborted), /already cancelled/u);
  assert.equal((await website.read(filename, { offset: 2, limit: 1 })).content[0]?.type, "text");
});
