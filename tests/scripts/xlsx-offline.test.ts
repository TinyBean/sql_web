import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { CodeInterpreterRuntime } from "../../src/server/tool/code-interpreter.ts";
import { ArtifactStore } from "../../src/server/tool/artifact-store.ts";
import { createExcelSkillContext } from "../../src/server/agent/xlsx-skill-runtime.ts";

const projectRoot = process.cwd();

function installOffline(wheels: string, target: string) {
  return spawnSync("/usr/bin/python3", ["-I", "-c", [
    "import runpy,sys",
    "def deny_network(event,args):",
    "    if event.startswith('socket.'):",
    "        raise RuntimeError('offline installation attempted network access: ' + event)",
    "sys.addaudithook(deny_network)",
    "sys.argv=['pip','--disable-pip-version-check','--no-cache-dir','install','--no-index','--find-links',sys.argv[1],'--only-binary=:all:','--require-hashes','--target',sys.argv[2],'-r',sys.argv[3]]",
    "runpy.run_module('pip',run_name='__main__')",
  ].join("\n"), wheels, target, path.join(projectRoot, "scripts/requirements-xlsx.txt")], {
    encoding: "utf8", timeout: 30000,
    env: { ...process.env, PIP_CONFIG_FILE: "/dev/null" },
  });
}

test("bundled wheels install without any network access and support sandbox Excel export", async (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "xlsx-offline-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const target = path.join(root, ".data/xlsx-python");
  const installed = installOffline(path.join(projectRoot, "vendor/xlsx"), target);
  assert.equal(installed.status, 0, installed.stderr + installed.stdout);

  const runtime = await CodeInterpreterRuntime.create({ projectRoot: root,
    pythonPath: "/usr/bin/python3", bwrapPath: "/usr/bin/bwrap", prlimitPath: "/usr/bin/prlimit" });
  t.after(() => runtime.dispose());
  assert.deepEqual(await runtime.checkXlsxSupport(), { available: true, reason: null });
  const artifacts = new ArtifactStore(path.join(root, "artifacts")).forSession("offline-12345678");
  artifacts.createDataSnapshot("offline-values", (fd) => {
    writeSync(fd, JSON.stringify({ columns: ["machine", "oee"], rows: [{ machine: "0007", oee: 0.1234 }], rowCount: 1, truncated: false }));
    return { columns: ["machine", "oee"], rowCount: 1 };
  });
  const exported = await createExcelSkillContext(artifacts, runtime, { info() {}, error() {} }).exportSnapshot({
    snapshot: "offline-values", columns: [{ key: "machine", format: "text" }, { key: "oee", format: "ratio" }],
  });
  assert.equal(exported.row_count, 1);
  const workbook = path.join(root, "artifacts/offline-12345678/exports", exported.file_id, "workbook.xlsx");
  const verified = spawnSync("/usr/bin/python3", ["-I", "-c", [
    "import sys; sys.path.insert(0,sys.argv[1])",
    "from openpyxl import load_workbook",
    "w=load_workbook(sys.argv[2]); s=w['数据']",
    "assert w.sheetnames == ['数据','说明']",
    "assert s['A2'].value == '0007' and s['B2'].value == 0.1234",
    "assert s['B2'].number_format == '0.00%'",
  ].join("\n"), target, workbook], { encoding: "utf8" });
  assert.equal(verified.status, 0, verified.stderr);
});

test("offline installation rejects modified wheels instead of downloading replacements", (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "xlsx-offline-integrity-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const wheels = path.join(root, "wheels");
  mkdirSync(wheels);
  cpSync(path.join(projectRoot, "vendor/xlsx"), wheels, { recursive: true });
  const filename = path.join(wheels, "openpyxl-3.1.5-py2.py3-none-any.whl");
  writeFileSync(filename, Buffer.concat([readFileSync(filename), Buffer.from("modified")]));
  const installed = installOffline(wheels, path.join(root, "packages"));
  assert.notEqual(installed.status, 0);
  assert.match(installed.stderr + installed.stdout, /DO NOT MATCH THE HASHES/u);
  assert.doesNotMatch(installed.stderr + installed.stdout, /attempted network access/u);
});
