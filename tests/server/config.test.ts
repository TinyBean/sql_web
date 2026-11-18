import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { loadConfig, loadProjectEnvironment } from "../../src/server/config.ts";
import { loadDataCommandConfig } from "../../scripts/database/data-command-config.ts";

test("web and daily analysis resolve default and custom virtual environments from the project root", () => {
  const model = { SQL_WEB_PROVIDER: "test", SQL_WEB_MODEL: "test" };
  const defaults = loadConfig(model);
  for (const [configured, expected] of [
    [undefined, path.join(defaults.projectRoot, ".venv/bin/python")],
    ["   ", path.join(defaults.projectRoot, ".venv/bin/python")],
    ["custom-venv/bin/python3", path.join(defaults.projectRoot, "custom-venv/bin/python3")],
    ["/opt/python-venv/bin/python", "/opt/python-venv/bin/python"],
  ] as const) {
    const environment = { ...model, ...(configured === undefined ? {} : { SQL_WEB_PYTHON_PATH: configured }) };
    assert.equal(loadConfig(environment).codeInterpreter.pythonPath, expected);
  }
  const root = "/tmp/sql-web-config-test";
  assert.equal(loadDataCommandConfig(root, {}).analysis.codeInterpreter.pythonPath, path.join(root, ".venv/bin/python"));
  assert.equal(loadDataCommandConfig(root, { SQL_WEB_PYTHON_PATH: "custom-venv/bin/python3" }).analysis.codeInterpreter.pythonPath,
    path.join(root, "custom-venv/bin/python3"));
  assert.equal(loadDataCommandConfig(root, { SQL_WEB_PYTHON_PATH: "/opt/python-venv/bin/python" }).analysis.codeInterpreter.pythonPath,
    "/opt/python-venv/bin/python");
});

test("web and data commands resolve the same per-field settings from conflicting environments", (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "sql-web-shared-config-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, ".env");
  writeFileSync(file, [
    "SQL_WEB_DB_PATH=db/file.sqlite", "SQL_WEB_DEFAULT_DASHBOARD_PATH=snapshots/file.json",
    "SQL_WEB_PYTHON_PATH=", "SQL_WEB_BWRAP_PATH=bin/file-bwrap",
    "SQL_WEB_PROVIDER=file-provider", "SQL_WEB_MODEL=file-model",
    "SQL_WEB_SMTP_HOST=file.example", "SQL_WEB_MAIL_FROM_ADDRESS=sender@example.com",
  ].join("\n"));
  const inherited = {
    SQL_WEB_DB_PATH: "shell.sqlite", SQL_WEB_DEFAULT_DASHBOARD_PATH: "shell.json",
    SQL_WEB_PYTHON_PATH: "bin/shell-python", SQL_WEB_BWRAP_PATH: "bin/shell-bwrap", SQL_WEB_PRLIMIT_PATH: "bin/prlimit",
    SQL_WEB_PROVIDER: "shell-provider", SQL_WEB_MODEL: "shell-model",
    SQL_WEB_SMTP_HOST: "shell.example", SQL_WEB_MAIL_FROM_NAME: "Sender",
  };
  const web = loadConfig(loadProjectEnvironment(file, { ...inherited }), root);
  const command = loadDataCommandConfig(root, inherited);
  for (const config of [web, command]) {
    assert.equal(config.databasePath, path.join(root, "db/file.sqlite"));
    assert.equal(config.defaultDashboardPath, path.join(root, "snapshots/file.json"));
  }
  for (const interpreter of [web.codeInterpreter, command.analysis.codeInterpreter]) {
    assert.deepEqual(interpreter, {
      pythonPath: path.join(root, ".venv/bin/python"), bwrapPath: path.join(root, "bin/file-bwrap"),
      prlimitPath: path.join(root, "bin/prlimit"),
    });
  }
  for (const email of [web.email, command.notificationOptions.loadEmail()]) {
    assert.deepEqual(email, { host: "file.example", port: 25, fromAddress: "sender@example.com", fromName: "Sender" });
  }
  for (const { provider, model } of [web.model, command.analysis]) {
    assert.equal(provider, "file-provider");
    assert.equal(model, "file-model");
  }
});

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

  const target: NodeJS.ProcessEnv = { SHELL_ONLY: "inherited" };
  const environment = loadProjectEnvironment(envPath, target);
  assert.equal(target["SQL_WEB_MODEL"], "test-model");
  assert.ok(!("SHELL_ONLY" in environment));
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

test("domain login has HTTP defaults, configurable routing and explicit Secure cookie validation", () => {
  const env = { SQL_WEB_PROVIDER: "test", SQL_WEB_MODEL: "test" };
  const defaults = loadConfig(env);
  assert.match(defaults.domainVerifyUrl, /^http:\/\/.*\/DomainAccountVerify$/u);
  assert.equal(defaults.authCookieSecure, false);
  assert.equal(defaults.userDashboardsPath, path.join(defaults.projectRoot, ".data/user-dashboards.json"));
  const configured = loadConfig({ ...env, SQL_WEB_DOMAIN_VERIFY_URL: "https://company.example/verify", SQL_WEB_AUTH_COOKIE_SECURE: "true", SQL_WEB_USER_DASHBOARDS_PATH: "custom/users.json" });
  assert.equal(configured.authCookieSecure, true);
  assert.equal(configured.domainVerifyUrl, "https://company.example/verify");
  assert.equal(configured.userDashboardsPath, path.join(configured.projectRoot, "custom/users.json"));
  assert.throws(() => loadConfig({ ...env, SQL_WEB_AUTH_COOKIE_SECURE: "yes" }), /COOKIE_SECURE/u);
  for (const url of ["file:///tmp/verify", "https://user:password@company.example/verify"]) {
    assert.throws(() => loadConfig({ ...env, SQL_WEB_DOMAIN_VERIFY_URL: url }));
  }
});

test("web and data commands only select models from the file, including when a field is missing", (t) => {
  const directory = mkdtempSync(path.join(tmpdir(), "sqlite-qa-config-"));
  const envPath = path.join(directory, ".env");
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const shell = { SQL_WEB_PROVIDER: "shell-provider", SQL_WEB_MODEL: "shell-model", SQL_WEB_DB_PATH: "shell.sqlite" };
  const withoutFile = loadDataCommandConfig(directory, shell);
  assert.equal(withoutFile.databasePath, path.join(directory, "shell.sqlite"));
  assert.equal(withoutFile.analysis.provider, "");
  assert.equal(withoutFile.analysis.model, "");
  for (const [content, provider, model] of [
    ["", "", ""], ["SQL_WEB_PROVIDER=file-provider", "file-provider", ""], ["SQL_WEB_MODEL=file-model", "", "file-model"],
  ] as const) {
    writeFileSync(envPath, content);
    assert.throws(() => loadConfig(loadProjectEnvironment(envPath, { ...shell })), /SQL_WEB_PROVIDER 和 SQL_WEB_MODEL/u);
    const { analysis } = loadDataCommandConfig(directory, shell);
    assert.equal(analysis.provider, provider);
    assert.equal(analysis.model, model);
  }
});

test("reports a missing project environment file", (t) => {
  const directory = mkdtempSync(path.join(tmpdir(), "sqlite-qa-config-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  assert.throws(
    () => loadProjectEnvironment(path.join(directory, "missing.env"), {}),
    /找不到环境配置文件/u,
  );
});

test("web query timeout loads from the project environment and fits a Node timer", (t) => {
  const env = { SQL_WEB_PROVIDER: "test", SQL_WEB_MODEL: "test" };
  assert.equal(loadConfig(env).queryTimeoutMs, 30_000);
  const root = mkdtempSync(path.join(tmpdir(), "web-query-config-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, ".env");
  writeFileSync(file, "SQL_WEB_PROVIDER=test\nSQL_WEB_MODEL=test\nSQL_WEB_QUERY_TIMEOUT_MS=500\n");
  assert.equal(loadConfig(loadProjectEnvironment(file, {})).queryTimeoutMs, 500);
  for (const value of ["", "0", "-1", "0.5", "bad", "2147483648"]) {
    assert.throws(() => loadConfig({ ...env, SQL_WEB_QUERY_TIMEOUT_MS: value }), /SQL_WEB_QUERY_TIMEOUT_MS/u);
  }
});
