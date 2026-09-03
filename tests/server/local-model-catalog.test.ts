import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  assertModelInLocalCatalog,
  LocalModelCatalogError,
} from "../../src/server/agent/local-model-catalog.ts";

test("accepts models declared in the project-local model store", (t) => {
  const agentDir = mkdtempSync(path.join(tmpdir(), "sqlite-qa-models-"));
  t.after(() => rmSync(agentDir, { recursive: true, force: true }));
  writeFileSync(
    path.join(agentDir, "models-store.json"),
    JSON.stringify({ zai: { models: [{ id: "glm-local" }] } }),
  );

  assert.doesNotThrow(() => {
    assertModelInLocalCatalog(agentDir, { provider: "zai", model: "glm-local" });
  });
});

test("does not accept an SDK built-in model absent from local files", (t) => {
  const agentDir = mkdtempSync(path.join(tmpdir(), "sqlite-qa-models-"));
  t.after(() => rmSync(agentDir, { recursive: true, force: true }));
  writeFileSync(path.join(agentDir, "models-store.json"), "{}");

  assert.throws(
    () => assertModelInLocalCatalog(agentDir, {
      provider: "anthropic",
      model: "claude-sonnet-4-5",
    }),
    LocalModelCatalogError,
  );
});
