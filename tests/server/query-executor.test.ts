import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test, { type TestContext } from "node:test";
import { QueryExecutor } from "../../src/server/database/query-executor.ts";
import { DatabaseInputError } from "../../src/server/database/database.ts";
import { ArtifactStore } from "../../src/server/tool/artifact-store.ts";
import { createExecuteSqlTool } from "../../src/server/tool/database-tools.ts";
import { pausedAggregate, pausingWorker, queryPid } from "../helpers/query-marker.ts";

function fixture(t: TestContext, timeoutMs = 30_000, worker?: URL) {
  const root = mkdtempSync(path.join(tmpdir(), "web-query-"));
  const filePath = path.join(root, "data.sqlite");
  const writer = new DatabaseSync(filePath);
  writer.exec("CREATE TABLE sample(n INTEGER); INSERT INTO sample VALUES(1), (2), (3)");
  writer.close();
  const executor = new QueryExecutor(filePath, timeoutMs, worker);
  const artifacts = new ArtifactStore(root).forSession("query-test");
  const tool = createExecuteSqlTool(executor, artifacts);
  const save = (name: string, sql: string, parameters: string[] = [], signal?: AbortSignal) =>
    tool.execute("test", { save_as: name, sql, parameters }, signal, undefined, undefined as never);
  t.after(async () => {
    await executor.close();
    rmSync(root, { recursive: true, force: true });
  });
  return { root, executor, artifacts, save };
}

function assertExited(pid: number) {
  assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
}

test("query process preserves bindings, inline limits, read-only errors and schema", async (t) => {
  const { executor } = fixture(t);
  const result = await executor.query("SELECT ? AS value, ? AS flag, ? AS blob FROM sample",
    [9_007_199_254_740_993n, true, new Uint8Array([1])], { maxRows: 1 });
  assert.deepEqual(result, { columns: ["value", "flag", "blob"], rows: [
    { value: "9007199254740993", flag: 1, blob: "[BLOB 1 bytes]" },
  ], rowCount: 1, truncated: true });
  await assert.rejects(executor.query("DELETE FROM sample"), DatabaseInputError);
  assert.deepEqual((await executor.getSchema()).map((entry) => entry.name), ["sample"]);
});

test("watchdog kills an aggregate before its first row and the next query succeeds", async (t) => {
  const { root, executor } = fixture(t, 3000, pausingWorker);
  const marker = path.join(root, "started");
  const rejected = assert.rejects(executor.query(pausedAggregate, [marker]), /查询超时.*3000/u);
  const pid = await queryPid(marker);
  await rejected;
  assertExited(pid);
  assert.deepEqual((await executor.query("SELECT SUM(n) AS total FROM sample")).rows, [{ total: 6 }]);
});

test("two slots admit in FIFO order, queued cancellation and expiry never run, shutdown reaps children", async (t) => {
  const { root, executor } = fixture(t, 30_000, pausingWorker);
  const marker = (name: string) => path.join(root, name);
  const pause = (name: string, signal?: AbortSignal) => executor.query(pausedAggregate, [marker(name)], {}, signal);
  const first = new AbortController();
  const a = assert.rejects(pause("a", first.signal), /first/u);
  const b = assert.rejects(pause("b"), /关闭/u);
  const [pidA, pidB] = await Promise.all([queryPid(marker("a")), queryPid(marker("b"))]);

  t.mock.timers.enable({ apis: ["setTimeout"] });
  const expired = assert.rejects(pause("expired"), /超时/u);
  t.mock.timers.tick(30_000);
  await expired;
  t.mock.timers.reset();
  const cancel = new AbortController();
  const skipped = assert.rejects(pause("skipped", cancel.signal), /queued/u);
  const c = assert.rejects(pause("c"), /关闭/u);
  const d = assert.rejects(pause("d"), /关闭/u);
  cancel.abort(new Error("queued"));
  await skipped;
  assert.equal(existsSync(marker("c")), false);
  first.abort(new Error("first"));
  await a;
  assertExited(pidA);
  const pidC = await queryPid(marker("c"));
  await executor.close();
  await Promise.all([b, c, d]);
  assertExited(pidB);
  assertExited(pidC);
  for (const name of ["expired", "skipped", "d"]) assert.equal(existsSync(marker(name)), false);
  await assert.rejects(executor.getSchema(), /关闭/u);
});

test("SQL snapshots preserve full text while the web tool marks shortened previews", async (t) => {
  const { artifacts, save } = fixture(t);
  const value = "测".repeat(2_500) + "末尾";
  const result = await save("text", "SELECT ? AS value", [value]);
  assert.ok(result.details && "preview" in result.details);
  assert.deepEqual(result.details.preview, {
    rows: [{ value: value.slice(0, 2_000) + "…" }], rowCount: 1, truncated: true,
  });
  const snapshot = artifacts.resolveDataSnapshot("text");
  const json = readFileSync(snapshot.filePath, "utf8");
  assert.equal(snapshot.byteCount, Buffer.byteLength(json));
  assert.deepEqual(JSON.parse(json), {
    columns: ["value"], rows: [{ value }], rowCount: 1, truncated: false, truncationReason: null,
  });
});

test("concurrent exports merge the manifest and interrupted replacements discard partial files", async (t) => {
  const { root, executor, artifacts, save } = fixture(t, 3000, pausingWorker);
  await Promise.all([save("left", "SELECT n FROM sample"), save("right", "SELECT 42 AS answer")]);
  const original = artifacts.resolveDataSnapshot("left");
  const files = () => readdirSync(path.join(root, "query-test")).sort();
  const before = files();
  for (const cause of ["abort", "crash", "timeout"] as const) {
    const marker = path.join(root, cause);
    const stop = new AbortController();
    const pending = save("left", pausedAggregate, [marker], stop.signal);
    const error = { abort: /stop/u, crash: /异常退出/u, timeout: /超时/u } as const;
    const rejected = assert.rejects(pending, error[cause]);
    const pid = await queryPid(marker);
    const staging = files().find((file) => file.endsWith(".tmp"));
    assert.ok(staging);
    assert.match(readFileSync(path.join(root, "query-test", staging), "utf8"), /"rows":\[$/u);
    if (cause === "abort") stop.abort(new Error("stop"));
    else if (cause === "crash") process.kill(pid, "SIGKILL");
    await rejected;
    assertExited(pid);
    assert.deepEqual(files(), before);
    assert.deepEqual(artifacts.resolveDataSnapshot("left"), original);
  }
  assert.deepEqual(artifacts.listDataSnapshots().map((entry) => entry.name), ["left", "right"]);
  assert.equal((await executor.query("SELECT 1")).rowCount, 1);
});
