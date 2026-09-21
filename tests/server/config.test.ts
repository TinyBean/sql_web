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
      "SQL_WEB_DEFAULT_DASHBOARD_PATH=.data/current-dashboard.json",
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
  assert.equal(config.defaultDashboardPath, path.join(config.projectRoot, ".data", "current-dashboard.json"));
  assert.equal(config.codeInterpreter.pythonPath, "/usr/local/bin/python3");
  assert.equal(config.codeInterpreter.bwrapPath, "/usr/bin/bwrap");
  assert.equal(config.email, null);
});

test("loads SMTP configuration preserving the quoted sender local part", (t) => {
  const directory = mkdtempSync(path.join(tmpdir(), "sqlite-qa-mail-config-"));
  const envPath = path.join(directory, ".env");
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  writeFileSync(envPath, [
    "SQL_WEB_PROVIDER=test", "SQL_WEB_MODEL=test",
    "SQL_WEB_SMTP_HOST=10.71.68.150", "SQL_WEB_SMTP_PORT=25",
    `SQL_WEB_MAIL_FROM_ADDRESS='"JV OEE Agent"@sdsscn.com'`,
    "SQL_WEB_MAIL_FROM_NAME=JV OEE Agent",
  ].join("\n"));
  assert.deepEqual(loadConfig(loadProjectEnvironment(envPath, {})).email, {
    host: "10.71.68.150", port: 25,
    fromAddress: '"JV OEE Agent"@sdsscn.com', fromName: "JV OEE Agent",
  });
});

test("rejects incomplete or invalid SMTP configuration", () => {
  const model = { SQL_WEB_PROVIDER: "test", SQL_WEB_MODEL: "test" };
  for (const partial of [{ SQL_WEB_SMTP_HOST: "10.71.68.150" }, { SQL_WEB_SMTP_PORT: "25" }, { SQL_WEB_MAIL_FROM_NAME: "Agent" }]) {
    assert.throws(() => loadConfig({ ...model, ...partial }), /启用邮件工具必须同时配置/u);
  }
  const valid = { ...model, SQL_WEB_SMTP_HOST: "10.71.68.150", SQL_WEB_MAIL_FROM_ADDRESS: '"JV OEE Agent"@sdsscn.com', SQL_WEB_MAIL_FROM_NAME: "JV OEE Agent" };
  assert.equal(loadConfig(valid).email?.port, 25);
  for (const invalid of [
    { SQL_WEB_SMTP_PORT: "70000" }, { SQL_WEB_SMTP_PORT: "NaN" },
    { SQL_WEB_MAIL_FROM_ADDRESS: "JV OEE Agent@sdsscn.com" },
    { SQL_WEB_MAIL_FROM_NAME: "Agent\nBcc: victim@example.com" },
    { SQL_WEB_SMTP_HOST: "smtp://10.71.68.150" },
  ]) assert.throws(() => loadConfig({ ...valid, ...invalid }));
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
