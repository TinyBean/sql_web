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
