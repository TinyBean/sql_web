import { existsSync } from "node:fs";
import { readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  defineTool,
  loadSkillsFromDir,
} from "@earendil-works/pi-coding-agent";
import type {
  ExtensionContext,
  ExtensionFactory,
  InlineExtension,
  LoadSkillsResult,
  Skill,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { AppDatabase } from "../data/database.ts";

export const SKILL_LOADED_ENTRY_TYPE = "sql_web.skill.loaded";
export const SKILL_READ_TOOL_NAME = "read";

const LOCAL_TOOL_NAME_PATTERN = /^[a-z][a-z0-9_]*$/u;
const PUBLISHED_TOOL_NAME_PATTERN = /^[a-z][a-z0-9_]{0,63}$/u;
const DEFAULT_READ_LINE_LIMIT = 2_000;
const MAX_READ_BYTES = 50 * 1024;

interface SkillLoadedEntryData {
  readonly name: string;
}

interface SkillToolFactoryContext {
  readonly database: AppDatabase;
}

type SkillToolFactory = (context: SkillToolFactoryContext) => readonly ToolDefinition[];

interface CatalogSkill {
  readonly skill: Skill;
  readonly namespace: string;
  readonly canonicalSkillFile: string;
  readonly canonicalBaseDir: string;
  readonly factory: SkillToolFactory | null;
  readonly localToolNames: readonly string[];
  readonly publishedToolNames: readonly string[];
}

export interface AgentSkillCatalog {
  readonly resources: LoadSkillsResult;
  readonly skillNames: readonly string[];
  readonly publishedToolNames: readonly string[];
  createSessionExtension(cwd: string): InlineExtension;
}

export interface LoadAgentSkillCatalogOptions {
  readonly database: AppDatabase;
  readonly directory?: string;
}

function defaultSkillsDirectory(): string {
  return path.resolve(import.meta.dirname, "..", "skills");
}

function isWithin(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate);
  return relative === "" || (
    relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
  );
}

function namespaceForSkill(name: string): string {
  const namespace = name.replaceAll("-", "_");
  if (!LOCAL_TOOL_NAME_PATTERN.test(namespace)) {
    throw new Error(`Skill ${name} 无法转换为合法的工具命名空间`);
  }
  return namespace;
}

function asToolFactory(moduleValue: unknown, modulePath: string): SkillToolFactory {
  if (
    typeof moduleValue !== "object" || moduleValue === null ||
    !("createTools" in moduleValue) || typeof moduleValue.createTools !== "function"
  ) {
    throw new Error(`Skill 工具模块必须导出 createTools(context):${modulePath}`);
  }
  return moduleValue.createTools as SkillToolFactory;
}

function validateToolDefinitions(
  skillName: string,
  namespace: string,
  definitions: readonly ToolDefinition[],
): { readonly localNames: string[]; readonly publishedNames: string[] } {
  if (!Array.isArray(definitions)) {
    throw new Error(`Skill ${skillName} 的 createTools() 必须返回工具数组`);
  }
  const localNames: string[] = [];
  const publishedNames: string[] = [];
  const seen = new Set<string>();
  for (const definition of definitions) {
    if (
      typeof definition !== "object" || definition === null ||
      typeof definition.name !== "string" || typeof definition.label !== "string" ||
      typeof definition.description !== "string" || typeof definition.execute !== "function" ||
      typeof definition.parameters !== "object" || definition.parameters === null
    ) {
      throw new Error(`Skill ${skillName} 返回了无效的工具定义`);
    }
    if (!LOCAL_TOOL_NAME_PATTERN.test(definition.name)) {
      throw new Error(`Skill ${skillName} 的局部工具名不合法:${definition.name}`);
    }
    if (seen.has(definition.name)) {
      throw new Error(`Skill ${skillName} 存在重复局部工具名:${definition.name}`);
    }
    const publishedName = `${namespace}__${definition.name}`;
    if (!PUBLISHED_TOOL_NAME_PATTERN.test(publishedName)) {
      throw new Error(`Skill 工具名不合法或超过 64 个字符:${publishedName}`);
    }
    seen.add(definition.name);
    localNames.push(definition.name);
    publishedNames.push(publishedName);
  }
  return { localNames, publishedNames };
}

function definitionsForRegistration(
  catalogSkill: CatalogSkill,
  database: AppDatabase,
): ToolDefinition[] {
  if (!catalogSkill.factory) return [];
  const definitions = catalogSkill.factory({ database });
  const validated = validateToolDefinitions(
    catalogSkill.skill.name,
    catalogSkill.namespace,
    definitions,
  );
  if (
    validated.localNames.length !== catalogSkill.localToolNames.length ||
    validated.localNames.some((name, index) => name !== catalogSkill.localToolNames[index])
  ) {
    throw new Error(`Skill ${catalogSkill.skill.name} 的工具定义在加载时发生变化`);
  }
  return definitions.map((definition, index) => ({
    ...definition,
    name: validated.publishedNames[index]!,
  }));
}

function loadedSkillsFromBranch(
  ctx: ExtensionContext,
  knownSkills: ReadonlySet<string>,
): Set<string> {
  const loaded = new Set<string>();
  for (const entry of ctx.sessionManager.getBranch()) {
    if (entry.type !== "custom" || entry.customType !== SKILL_LOADED_ENTRY_TYPE) continue;
    const data = entry.data as Partial<SkillLoadedEntryData> | undefined;
    if (typeof data?.name === "string" && knownSkills.has(data.name)) loaded.add(data.name);
  }
  return loaded;
}

function explicitSkillName(text: string): string | null {
  return /^\/skill:([a-z0-9]+(?:-[a-z0-9]+)*)(?:\s|$)/u.exec(text.trimStart())?.[1] ?? null;
}

async function resolveReadableFile(
  requestedPath: string,
  cwd: string,
  catalogSkills: readonly CatalogSkill[],
): Promise<{ readonly canonicalPath: string; readonly skill: CatalogSkill }> {
  const resolvedPath = path.resolve(cwd, requestedPath);
  let canonicalPath: string;
  try {
    canonicalPath = await realpath(resolvedPath);
  } catch {
    throw new Error(`Skill 文件不存在:${requestedPath}`);
  }
  const fileStat = await stat(canonicalPath);
  if (!fileStat.isFile()) throw new Error(`read 仅支持读取 Skill 内的普通文件:${requestedPath}`);
  const skill = catalogSkills.find((candidate) => isWithin(candidate.canonicalBaseDir, canonicalPath));
  if (!skill) throw new Error(`read 仅允许访问已扫描到的 Skill 目录:${requestedPath}`);
  return { canonicalPath, skill };
}

function createSkillRuntimeExtension(
  catalogSkills: readonly CatalogSkill[],
  database: AppDatabase,
  cwd: string,
): ExtensionFactory {
  const skillsByName = new Map(catalogSkills.map((catalogSkill) => [
    catalogSkill.skill.name,
    catalogSkill,
  ]));
  const knownSkills = new Set(skillsByName.keys());
  const everyPublishedTool = new Set(catalogSkills.flatMap((skill) => skill.publishedToolNames));

  return (pi) => {
    const registeredSkills = new Set<string>();
    let loadedSkills = new Set<string>();
    let baseActiveTools: string[] | null = null;

    const captureBaseTools = (): string[] => {
      baseActiveTools ??= pi.getActiveTools().filter((name) => !everyPublishedTool.has(name));
      return baseActiveTools;
    };

    const register = (skillName: string): readonly string[] => {
      if (registeredSkills.has(skillName)) {
        return skillsByName.get(skillName)?.publishedToolNames ?? [];
      }
      const catalogSkill = skillsByName.get(skillName);
      if (!catalogSkill) throw new Error(`未知 Skill:${skillName}`);
      for (const definition of definitionsForRegistration(catalogSkill, database)) {
        pi.registerTool(definition);
      }
      registeredSkills.add(skillName);
      return catalogSkill.publishedToolNames;
    };

    const reconcile = (desiredSkills: ReadonlySet<string>): void => {
      for (const catalogSkill of catalogSkills) {
        if (desiredSkills.has(catalogSkill.skill.name)) register(catalogSkill.skill.name);
      }
      loadedSkills = new Set(desiredSkills);
      const activeSkillTools = catalogSkills.flatMap((catalogSkill) => (
        desiredSkills.has(catalogSkill.skill.name) ? catalogSkill.publishedToolNames : []
      ));
      pi.setActiveTools([...captureBaseTools(), ...activeSkillTools]);
    };

    const activate = (skillName: string, persist: boolean): readonly string[] => {
      if (!knownSkills.has(skillName)) throw new Error(`未知 Skill:${skillName}`);
      if (loadedSkills.has(skillName)) return skillsByName.get(skillName)?.publishedToolNames ?? [];
      reconcile(new Set([...loadedSkills, skillName]));
      if (persist) pi.appendEntry<SkillLoadedEntryData>(SKILL_LOADED_ENTRY_TYPE, { name: skillName });
      return skillsByName.get(skillName)?.publishedToolNames ?? [];
    };

    pi.registerTool(defineTool({
      name: SKILL_READ_TOOL_NAME,
      label: "读取 Skill 文件",
      description:
        "Read a file only from a Skill directory listed in <available_skills>. Reading the exact SKILL.md activates that Skill's session-local tools.",
      executionMode: "sequential",
      parameters: Type.Object({
        path: Type.String({ description: "Absolute path, or a path relative to the working directory." }),
        offset: Type.Optional(Type.Integer({ minimum: 1, description: "First line to return (1-based)." })),
        limit: Type.Optional(Type.Integer({ minimum: 1, maximum: DEFAULT_READ_LINE_LIMIT })),
      }),
      async execute(_toolCallId, params, signal) {
        signal?.throwIfAborted();
        const { canonicalPath, skill } = await resolveReadableFile(params.path, cwd, catalogSkills);
        const content = await readFile(canonicalPath, "utf8");
        signal?.throwIfAborted();
        if (Buffer.byteLength(content) > MAX_READ_BYTES) {
          throw new Error(`Skill 文件超过 ${MAX_READ_BYTES} 字节读取上限:${params.path}`);
        }
        const lines = content.split(/\r?\n/u);
        const offset = params.offset ?? 1;
        const limit = params.limit ?? DEFAULT_READ_LINE_LIMIT;
        const selected = lines.slice(offset - 1, offset - 1 + limit).join("\n");
        const isSkillEntry = canonicalPath === skill.canonicalSkillFile;
        const addedTools = isSkillEntry ? activate(skill.skill.name, true) : [];
        return {
          content: [{ type: "text" as const, text: selected }],
          details: {
            path: canonicalPath,
            totalLines: lines.length,
            ...(isSkillEntry ? { loadedSkill: skill.skill.name, addedTools } : {}),
          },
        };
      },
    }));

    pi.on("input", (event) => {
      const skillName = explicitSkillName(event.text);
      if (skillName && knownSkills.has(skillName)) activate(skillName, true);
      return { action: "continue" };
    });
    pi.on("session_start", (_event, ctx) => reconcile(loadedSkillsFromBranch(ctx, knownSkills)));
    pi.on("session_tree", (_event, ctx) => reconcile(loadedSkillsFromBranch(ctx, knownSkills)));
  };
}

export async function loadAgentSkillCatalog({
  database,
  directory = defaultSkillsDirectory(),
}: LoadAgentSkillCatalogOptions): Promise<AgentSkillCatalog> {
  const configuredDirectory = path.resolve(directory);
  if (!existsSync(configuredDirectory)) {
    throw new Error(`Skill 目录不存在:${configuredDirectory}`);
  }
  const canonicalRoot = await realpath(configuredDirectory);
  const discovered = loadSkillsFromDir({ dir: configuredDirectory, source: "project" });
  const skillDiagnostics = discovered.diagnostics.filter((diagnostic) => (
    diagnostic.path === undefined || path.basename(diagnostic.path) === "SKILL.md"
  ));
  if (skillDiagnostics.length) {
    const messages = skillDiagnostics.map((diagnostic) => (
      `${diagnostic.path ?? configuredDirectory}:${diagnostic.message}`
    ));
    throw new Error(`Skill 目录校验失败:\n${messages.join("\n")}`);
  }

  const catalogSkills: CatalogSkill[] = [];
  const seenSkillNames = new Set<string>();
  const seenNamespaces = new Map<string, string>();
  const seenPublishedTools = new Set<string>();
  const declaredSkills = discovered.skills.filter((skill) => path.basename(skill.filePath) === "SKILL.md");
  for (const discoveredSkill of [...declaredSkills].sort((left, right) => (
    left.name.localeCompare(right.name)
  ))) {
    if (seenSkillNames.has(discoveredSkill.name)) {
      throw new Error(`重复 Skill 名:${discoveredSkill.name}`);
    }
    const canonicalBaseDir = await realpath(discoveredSkill.baseDir);
    const canonicalSkillFile = await realpath(discoveredSkill.filePath);
    if (!isWithin(canonicalRoot, canonicalBaseDir) || !isWithin(canonicalBaseDir, canonicalSkillFile)) {
      throw new Error(`Skill 路径通过符号链接逃逸扫描目录:${discoveredSkill.filePath}`);
    }
    const skill: Skill = {
      ...discoveredSkill,
      baseDir: canonicalBaseDir,
      filePath: canonicalSkillFile,
    };
    const namespace = namespaceForSkill(skill.name);
    const namespaceOwner = seenNamespaces.get(namespace);
    if (namespaceOwner) {
      throw new Error(`Skill 命名空间冲突:${namespaceOwner} 与 ${skill.name} -> ${namespace}`);
    }
    seenNamespaces.set(namespace, skill.name);
    const moduleCandidates = [
      path.join(canonicalBaseDir, "tools.js"),
      path.join(canonicalBaseDir, "tools.ts"),
    ];
    const modulePath = moduleCandidates.find(existsSync);
    let factory: SkillToolFactory | null = null;
    let localToolNames: string[] = [];
    let publishedToolNames: string[] = [];
    if (modulePath) {
      const canonicalModulePath = await realpath(modulePath);
      if (!isWithin(canonicalBaseDir, canonicalModulePath)) {
        throw new Error(`Skill 工具模块通过符号链接逃逸 Skill 目录:${modulePath}`);
      }
      factory = asToolFactory(await import(pathToFileURL(canonicalModulePath).href), modulePath);
      const validated = validateToolDefinitions(skill.name, namespace, factory({ database }));
      localToolNames = validated.localNames;
      publishedToolNames = validated.publishedNames;
      for (const publishedName of publishedToolNames) {
        if (seenPublishedTools.has(publishedName)) {
          throw new Error(`Skill 工具名冲突:${publishedName}`);
        }
        seenPublishedTools.add(publishedName);
      }
    }
    seenSkillNames.add(skill.name);
    catalogSkills.push({
      skill,
      namespace,
      canonicalSkillFile,
      canonicalBaseDir,
      factory,
      localToolNames,
      publishedToolNames,
    });
  }

  const resources: LoadSkillsResult = {
    skills: catalogSkills.map((entry) => entry.skill),
    diagnostics: [],
  };
  return {
    resources,
    skillNames: catalogSkills.map((entry) => entry.skill.name),
    publishedToolNames: catalogSkills.flatMap((entry) => entry.publishedToolNames),
    createSessionExtension: (cwd) => ({
      name: "sql-web-skill-runtime",
      hidden: true,
      factory: createSkillRuntimeExtension(catalogSkills, database, path.resolve(cwd)),
    }),
  };
}
