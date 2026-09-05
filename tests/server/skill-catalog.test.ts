import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { loadAgentSkillCatalog } from "../../src/server/agent/skill-catalog.ts";

const VALID_TOOL_MODULE = `export function createTools(...args) {
  if (args.length !== 0) throw new Error("createTools must not receive catalog context");
  return [{
    name: "run",
    label: "Run",
    description: "Run the fixture tool.",
    parameters: { type: "object", properties: {} },
    async execute() { return { content: [{ type: "text", text: "ok" }] }; }
  }];
}
`;

function writeSkill(
  root: string,
  directoryName: string,
  skillName: string,
  toolModule = VALID_TOOL_MODULE,
): void {
  const directory = path.join(root, directoryName);
  mkdirSync(directory, { recursive: true });
  writeFileSync(
    path.join(directory, "SKILL.md"),
    `---\nname: ${skillName}\ndescription: A fixture skill used to validate catalog discovery behavior.\n---\n\n# Fixture\n`,
  );
  const assetsDirectory = path.join(directory, "assets");
  mkdirSync(assetsDirectory);
  writeFileSync(path.join(assetsDirectory, "tools.js"), toolModule);
}

function fixtureRoot(t: TestContext): string {
  const root = mkdtempSync(path.join(tmpdir(), "sqlite-qa-skill-catalog-"));
  writeFileSync(path.join(root, "package.json"), JSON.stringify({ type: "module" }));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

test("discovers namespaced Skill tools without exposing a global registry", async (t) => {
  const root = fixtureRoot(t);
  writeSkill(root, "sample-calculator", "sample-calculator");
  writeFileSync(
    path.join(root, "NOT-A-SKILL.md"),
    "---\nname: stray-markdown\ndescription: This metadata file must not be scanned as a Skill.\n---\n",
  );

  const catalog = await loadAgentSkillCatalog({ directory: root });
  assert.deepEqual(catalog.skillNames, ["sample-calculator"]);
  assert.deepEqual(catalog.publishedToolNames, ["sample_calculator__run"]);
  assert.deepEqual(catalog.resources.skills.map((skill) => skill.name), ["sample-calculator"]);

  const registered = new Map<string, ToolDefinition>();
  const handlers = new Map<string, (...arguments_: never[]) => unknown>();
  const persisted: { customType: string; data: unknown }[] = [];
  let activeTools = ["read", "execute_sql"];
  const extension = catalog.createSessionExtension(root);
  const factory = typeof extension === "function" ? extension : extension.factory;
  await factory({
    registerTool: (definition: ToolDefinition) => registered.set(definition.name, definition),
    on: (event: string, handler: (...arguments_: never[]) => unknown) => handlers.set(event, handler),
    getActiveTools: () => [...activeTools],
    setActiveTools: (names: string[]) => {
      activeTools = [...names];
    },
    appendEntry: (customType: string, data: unknown) => persisted.push({ customType, data }),
  } as never);
  assert.deepEqual([...registered.keys()], ["read"]);
  assert.equal(handlers.has("input"), false);
  const readTool = registered.get("read");
  assert.ok(readTool);
  await readTool.execute(
    "read-skill",
    { path: path.join(root, "sample-calculator", "SKILL.md") },
    undefined,
    undefined,
    undefined as never,
  );
  assert.deepEqual([...registered.keys()], ["read", "sample_calculator__run"]);
  assert.deepEqual(activeTools, ["read", "execute_sql", "sample_calculator__run"]);
  assert.deepEqual(persisted, [{
    customType: "sql_web.skill.loaded",
    data: { name: "sample-calculator" },
  }]);
  await readTool.execute(
    "read-skill-again",
    { path: path.join(root, "sample-calculator", "SKILL.md") },
    undefined,
    undefined,
    undefined as never,
  );
  assert.equal(persisted.length, 1);
});

test("rejects Skill tools in the legacy root directory", async (t) => {
  const root = fixtureRoot(t);
  const directory = path.join(root, "legacy-calculator");
  mkdirSync(directory, { recursive: true });
  writeFileSync(
    path.join(directory, "SKILL.md"),
    "---\nname: legacy-calculator\ndescription: A legacy fixture with a root-level tool module.\n---\n\n# Legacy fixture\n",
  );
  writeFileSync(path.join(directory, "tools.js"), VALID_TOOL_MODULE);

  await assert.rejects(
    () => loadAgentSkillCatalog({ directory: root }),
    /工具模块必须放在 assets\//u,
  );
});

test("rejects duplicate local names and overlong published names", async (t) => {
  const duplicateRoot = fixtureRoot(t);
  writeSkill(duplicateRoot, "duplicate-skill", "duplicate-skill", `export function createTools() {
    const tool = { name: "run", label: "Run", description: "Run.", parameters: {}, async execute() { return { content: [] }; } };
    return [tool, { ...tool }];
  }
  `);
  await assert.rejects(
    () => loadAgentSkillCatalog({ directory: duplicateRoot }),
    /重复局部工具名/u,
  );

  const longRoot = fixtureRoot(t);
  writeSkill(longRoot, "long-skill", "long-skill", `export function createTools() {
    return [{ name: "${"x".repeat(60)}", label: "Long", description: "Long.", parameters: {}, async execute() { return { content: [] }; } }];
  }
  `);
  await assert.rejects(
    () => loadAgentSkillCatalog({ directory: longRoot }),
    /超过 64/u,
  );
});

test("rejects duplicate Skill names and symlink escapes", async (t) => {
  const duplicateRoot = fixtureRoot(t);
  writeSkill(duplicateRoot, "first", "same-skill");
  writeSkill(duplicateRoot, "second", "same-skill");
  await assert.rejects(
    () => loadAgentSkillCatalog({ directory: duplicateRoot }),
    /重复 Skill 名/u,
  );

  const root = fixtureRoot(t);
  const external = mkdtempSync(path.join(tmpdir(), "sqlite-qa-external-skill-"));
  t.after(() => rmSync(external, { recursive: true, force: true }));
  writeSkill(external, "escaped", "escaped-skill");
  symlinkSync(path.join(external, "escaped"), path.join(root, "escaped"), "dir");
  await assert.rejects(
    () => loadAgentSkillCatalog({ directory: root }),
    /符号链接逃逸/u,
  );
});
