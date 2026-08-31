import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { loadConfig, loadProjectEnvironment } from "../src/config.js";

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
    ].join("\n"),
  );
  t.after(() => rmSync(directory, { recursive: true, force: true }));

  const environment = loadProjectEnvironment(envPath, {});
  const config = loadConfig(environment);

  assert.equal(config.host, "0.0.0.0");
  assert.equal(config.port, 4321);
  assert.deepEqual(config.model, { provider: "test-provider", model: "test-model" });
  assert.equal(config.agentDir, path.join(config.projectRoot, ".data", "agent"));
});

test("requires both model fields", () => {
  assert.throws(
    () => loadConfig({ SQL_WEB_PROVIDER: "test-provider" }),
    /SQL_WEB_PROVIDER 和 SQL_WEB_MODEL/u,
  );
});

test("reports a missing project environment file", () => {
  assert.throws(
    () => loadProjectEnvironment(path.join(tmpdir(), "missing-sql-web.env"), {}),
    /找不到环境配置文件/u,
  );
});
