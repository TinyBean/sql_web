import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { AgentSessionStore, SessionNotFoundError } from "../../src/server/agent/agent-sessions.ts";
import { ArtifactStore } from "../../src/server/agent/artifact-store.ts";
import { CodeInterpreterRuntime } from "../../src/server/agent/code-interpreter.ts";
import { AppDatabase } from "../../src/server/data/database.ts";

const projectRoot = process.cwd();

test("maps a web session directly to a Pi session with only allowlisted tools", async (t) => {
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
  const database = AppDatabase.open({
    filePath: path.join(directory, "oee.sqlite"),
    schemaPath: path.join(projectRoot, "sql", "schema.sql"),
  });
  const artifacts = new ArtifactStore(path.join(directory, "artifacts"));
  const codeInterpreter = await CodeInterpreterRuntime.create({
    pythonPath: "/usr/bin/python3",
    bwrapPath: "/usr/bin/bwrap",
    prlimitPath: "/usr/bin/prlimit",
    projectRoot: directory,
  });
  assert.equal(codeInterpreter.status.available, true);
  const store = await AgentSessionStore.open({
    database,
    artifacts,
    codeInterpreter,
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
  assert.deepEqual(created.tools, ["execute_sql", "get_current_time", "code_interpreter"]);
  assert.equal(created.model?.provider, "test-provider");
  assert.equal(created.model?.id, "test-model");

  const piSession = await store.get(created.id);
  assert.match(piSession.systemPrompt, /## 数据库结构/u);
  assert.match(piSession.systemPrompt, /CREATE TABLE oee_availability/u);
  assert.match(piSession.systemPrompt, /CREATE TABLE oee_dut_utilization/u);
  assert.match(piSession.systemPrompt, /<database_schema dialect="sqlite">/u);
  assert.match(piSession.systemPrompt, /execute_sql 只允许执行一条会返回结果集的只读 SQL/u);
  assert.match(piSession.systemPrompt, /get_current_time/u);
  assert.match(piSession.systemPrompt, /code_interpreter\.input_json/u);
  assert.doesNotMatch(piSession.systemPrompt, /SimHei|matplotlib_chinese_font|chinese_font/u);

  const codeInterpreterDefinition = piSession.getToolDefinition("code_interpreter");
  assert.ok(codeInterpreterDefinition);
  assert.match(codeInterpreterDefinition.description, /Simplified Chinese system font/u);
  assert.match(codeInterpreterDefinition.description, /do not replace.*SimHei/u);
  assert.match(codeInterpreterDefinition.description, /matplotlib_chinese_font\(size\)/u);
  assert.match(codeInterpreterDefinition.description, /chinese_font\(size\)/u);

  const listed = await store.list();
  assert.equal(listed.length, 1);
  assert.equal(listed[0]?.id, created.id);

  artifacts.forSession(created.id).createJson((fileDescriptor) => writeSync(fileDescriptor, "{}"));
  assert.equal(existsSync(path.join(directory, "artifacts", created.id)), true);
  await store.delete(created.id);
  assert.equal(existsSync(path.join(directory, "artifacts", created.id)), false);
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
