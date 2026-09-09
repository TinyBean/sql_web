import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import test from "node:test";
import {
  ArtifactInputError,
  ArtifactStore,
  normalizeDataSnapshotName,
} from "../../src/server/tool/artifact-store.ts";

test("creates durable session-scoped JSON artifacts and deletes them with the session", async (t) => {
  const directory = mkdtempSync(path.join(tmpdir(), "sqlite-qa-artifacts-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const store = new ArtifactStore(directory);
  const session = store.forSession("session-12345678");
  const created = session.createJson((fileDescriptor) => {
    writeSync(fileDescriptor, '{"ok":true}');
    return { ok: true };
  });

  assert.match(created.fileUri, /^artifact:\/\/session-12345678\/[0-9a-f-]+\.json$/u);
  const resolved = session.resolveJsonUri(created.fileUri);
  assert.equal(readFileSync(resolved, "utf8"), '{"ok":true}');
  assert.equal(created.byteCount, 11);

  const reopened = new ArtifactStore(directory).forSession("session-12345678");
  assert.equal(reopened.resolveJsonUri(created.fileUri), resolved);
  assert.throws(
    () => store.forSession("session-87654321").resolveJsonUri(created.fileUri),
    (error) => error instanceof ArtifactInputError && /其他会话/u.test(error.message),
  );

  await store.deleteSession("session-12345678");
  assert.equal(existsSync(path.dirname(resolved)), false);
});

test("rejects arbitrary paths, forged names, and symbolic links", (t) => {
  const directory = mkdtempSync(path.join(tmpdir(), "sqlite-qa-artifacts-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const sessionId = "session-12345678";
  const store = new ArtifactStore(directory);
  const session = store.forSession(sessionId);

  for (const uri of [
    "/etc/passwd",
    "file:///etc/passwd",
    `artifact://${sessionId}/../secret.json`,
    `artifact://${sessionId}/not-a-uuid.json`,
  ]) {
    assert.throws(() => session.resolveJsonUri(uri), ArtifactInputError, uri);
  }

  const sessionDir = path.join(directory, sessionId);
  mkdirSync(sessionDir, { recursive: true });
  const artifactName = `${randomUUID()}.json`;
  symlinkSync("/etc/passwd", path.join(sessionDir, artifactName));
  assert.throws(
    () => session.resolveJsonUri(`artifact://${sessionId}/${artifactName}`),
    (error) => error instanceof ArtifactInputError && /文件类型/u.test(error.message),
  );
});

test("removes partial files when artifact production fails", (t) => {
  const directory = mkdtempSync(path.join(tmpdir(), "sqlite-qa-artifacts-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const session = new ArtifactStore(directory).forSession("session-12345678");
  assert.throws(() => session.createJson((fileDescriptor) => {
    writeSync(fileDescriptor, "partial");
    throw new Error("stop");
  }), /stop/u);
  assert.deepEqual(readdirSync(path.join(directory, "session-12345678")), []);
});

test("removes ephemeral JSON after successful and failed consumers", async (t) => {
  const directory = mkdtempSync(path.join(tmpdir(), "sqlite-qa-artifacts-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const session = new ArtifactStore(directory).forSession("session-12345678");

  const value = await session.withEphemeralJson(
    (fileDescriptor) => {
      writeSync(fileDescriptor, '{"value":42}');
      return 42;
    },
    async (artifact) => {
      assert.equal(readFileSync(artifact.filePath, "utf8"), '{"value":42}');
      assert.equal(artifact.byteCount, 12);
      return artifact.value;
    },
  );
  assert.equal(value, 42);
  assert.deepEqual(readdirSync(path.join(directory, "session-12345678")), []);

  await assert.rejects(
    () => session.withEphemeralJson(
      (fileDescriptor) => {
        writeSync(fileDescriptor, "{}");
        return null;
      },
      async () => {
        throw new Error("consumer failed");
      },
    ),
    /consumer failed/u,
  );
  assert.deepEqual(readdirSync(path.join(directory, "session-12345678")), []);
});

test("stores normalized logical snapshots and atomically replaces them", async (t) => {
  const directory = mkdtempSync(path.join(tmpdir(), "sqlite-qa-snapshots-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const store = new ArtifactStore(directory);
  const session = store.forSession("session-12345678");

  assert.equal(normalizeDataSnapshotName("  OEE_日 趋势!  "), "oee-日-趋势");
  assert.throws(() => normalizeDataSnapshotName("📈"), /必须包含/u);

  const first = session.createDataSnapshot("OEE_日 趋势!", (fileDescriptor) => {
    writeSync(fileDescriptor, '{"rows":[{"value":1}]}');
    return { columns: ["value"], rowCount: 1, marker: "first" };
  });
  assert.equal(first.name, "oee-日-趋势");
  assert.equal(first.replaced, false);
  assert.equal(first.value.marker, "first");
  assert.equal("fileUri" in first, false);
  assert.equal("filePath" in first, false);
  const firstResolved = session.resolveDataSnapshot(" OEE 日_趋势 ");
  assert.equal(firstResolved.version, first.version);
  assert.equal(readFileSync(firstResolved.filePath, "utf8"), '{"rows":[{"value":1}]}');

  const reopened = new ArtifactStore(directory).forSession("session-12345678");
  assert.equal(reopened.resolveDataSnapshot("oee-日-趋势").version, first.version);
  assert.throws(
    () => store.forSession("session-87654321").resolveDataSnapshot("oee-日-趋势"),
    /不存在.*可用快照：无/u,
  );

  assert.throws(
    () => session.createDataSnapshot("oee-日-趋势", (fileDescriptor) => {
      writeSync(fileDescriptor, "partial");
      throw new Error("query failed");
    }),
    /query failed/u,
  );
  assert.equal(session.resolveDataSnapshot("oee-日-趋势").version, first.version);

  const second = session.createDataSnapshot("OEE 日 趋势", (fileDescriptor) => {
    writeSync(fileDescriptor, '{"rows":[{"value":2}]}');
    return { columns: ["value"], rowCount: 1, marker: "second" };
  });
  assert.equal(second.replaced, true);
  assert.notEqual(second.version, first.version);
  assert.equal(existsSync(firstResolved.filePath), false);
  assert.equal(readFileSync(session.resolveDataSnapshot(second.name).filePath, "utf8"), '{"rows":[{"value":2}]}');
  assert.deepEqual(session.listDataSnapshots().map((snapshot) => snapshot.name), ["oee-日-趋势"]);

  await store.deleteSession("session-12345678");
  assert.equal(existsSync(path.join(directory, "session-12345678")), false);
});
