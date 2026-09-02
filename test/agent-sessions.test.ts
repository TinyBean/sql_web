import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { AgentSessionStore, SessionNotFoundError } from "../src/agent-sessions.ts";
import { DemoDatabase } from "../src/database.ts";

const projectRoot = process.cwd();

test("maps a web session directly to a Pi session with only database tools", async (t) => {
  const directory = mkdtempSync(path.join(tmpdir(), "sqlite-qa-agent-"));
  const agentDir = path.join(directory, "agent");
  mkdirSync(agentDir, { recursive: true });
  writeFileSync(
    path.join(agentDir, "models.json"),
    JSON.stringify({
      providers: {
        "test-provider": {
          baseUrl: "http://127.0.0.1:1/v1",
          api: "openai-completions",
          apiKey: "test-only",
          models: [{ id: "test-model", name: "Test Model" }],
        },
      },
    }),
  );
  const database = DemoDatabase.open({
    filePath: path.join(directory, "demo.sqlite"),
    schemaPath: path.join(projectRoot, "sql", "schema.sql"),
    seedPath: path.join(projectRoot, "sql", "seed.sql"),
  });
  const store = await AgentSessionStore.open({
    database,
    cwd: directory,
    sessionDir: path.join(directory, "sessions"),
    agentDir,
    model: { provider: "test-provider", model: "test-model" },
  });
  t.after(() => {
    store.dispose();
    database.close();
    rmSync(directory, { recursive: true, force: true });
  });

  const created = await store.create();
  assert.match(created.id, /^[A-Za-z0-9-]{8,100}$/u);
  assert.deepEqual(created.tools, ["query_database", "execute_database"]);
  assert.equal(created.model?.provider, "test-provider");
  assert.equal(created.model?.id, "test-model");

  const piSession = await store.get(created.id);
  assert.match(piSession.systemPrompt, /sqlite_master/u);
  assert.doesNotMatch(piSession.systemPrompt, /CREATE TABLE|customers|orders/u);

  const listed = await store.list();
  assert.equal(listed.length, 1);
  assert.equal(listed[0]?.id, created.id);

  await store.delete(created.id);
  assert.deepEqual(await store.list(), []);
  await assert.rejects(() => store.get(created.id), SessionNotFoundError);

  const sessionDir = path.join(directory, "sessions");
  const persistedManager = SessionManager.create(directory, sessionDir);
  const persistedId = persistedManager.getSessionId();
  const persistedPath = persistedManager.getSessionFile();
  assert.ok(persistedPath);
  writeFileSync(persistedPath, `${JSON.stringify({
    type: "session",
    version: 3,
    id: persistedId,
    timestamp: new Date().toISOString(),
    cwd: directory,
  })}\n`);
  assert.equal(existsSync(persistedPath), true);
  assert.equal((await store.list()).some((item) => item.id === persistedId), true);

  await store.delete(persistedId);
  assert.equal(existsSync(persistedPath), false);
  assert.equal((await store.list()).some((item) => item.id === persistedId), false);
  await assert.rejects(() => store.get(persistedId), SessionNotFoundError);
});
