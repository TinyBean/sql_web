import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { loadConfig, loadProjectEnvironment } from "../../src/server/config.ts";

test("loads the selected model from the project environment file", (t) => {
  const directory = mkdtempSync(path.join(tmpdir(), "sqlite-qa-config-"));
  const envPath = path.join(directory, ".env");
  writeFileSync(
    envPath,
    [
      "HOST=0.0.0.0",
      "PORT=4321",
      "SQL_WEB_PROVIDER=test-provider",
      "SQL_WEB_MODEL=test-model",
      "SQL_WEB_ARTIFACT_DIR=.data/test-artifacts",
      "SQL_WEB_PYTHON_PATH=/usr/local/bin/python3",
    ].join("\n"),
  );
  t.after(() => rmSync(directory, { recursive: true, force: true }));

  const environment = loadProjectEnvironment(envPath, {});
  const config = loadConfig(environment);

  assert.equal(config.host, "0.0.0.0");
  assert.equal(config.port, 4321);
  assert.deepEqual(config.model, { provider: "test-provider", model: "test-model" });
  assert.equal(config.agentDir, path.join(config.projectRoot, ".data", "agent"));
  assert.equal(config.logDir, path.join(config.projectRoot, ".data", "logs"));
  assert.equal(config.artifactDir, path.join(config.projectRoot, ".data", "test-artifacts"));
  assert.equal(config.codeInterpreter.pythonPath, "/usr/local/bin/python3");
  assert.equal(config.codeInterpreter.bwrapPath, "/usr/bin/bwrap");
});

test("requires both model fields", () => {
  assert.throws(
    () => loadConfig({ SQL_WEB_PROVIDER: "test-provider" }),
    /SQL_WEB_PROVIDER 和 SQL_WEB_MODEL/u,
  );
});

test("does not inherit the selected model from the shell", (t) => {
  const directory = mkdtempSync(path.join(tmpdir(), "sqlite-qa-config-"));
  const envPath = path.join(directory, ".env");
  writeFileSync(envPath, "PORT=3000\n");
  t.after(() => rmSync(directory, { recursive: true, force: true }));

  const environment = loadProjectEnvironment(envPath, {
    SQL_WEB_PROVIDER: "shell-provider",
    SQL_WEB_MODEL: "shell-model",
  });
  assert.throws(() => loadConfig(environment), /SQL_WEB_PROVIDER 和 SQL_WEB_MODEL/u);
});

test("reports a missing project environment file", (t) => {
  const directory = mkdtempSync(path.join(tmpdir(), "sqlite-qa-config-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  assert.throws(
    () => loadProjectEnvironment(path.join(directory, "missing.env"), {}),
    /找不到环境配置文件/u,
  );
});
