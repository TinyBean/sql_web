import { mkdirSync } from "node:fs";
import path from "node:path";
import {
  createAgentSession,
  createExtensionRuntime,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import type {
  AgentSession,
  ResourceLoader,
} from "@earendil-works/pi-coding-agent";
import type {
  AgentStatus,
  ChatMessage,
  DatabaseToolName,
  ModelSelection,
  SerializedSession,
  SessionSummary,
} from "../shared/contracts.ts";
import type { DemoDatabase } from "./database.ts";
import { createDatabaseTools, DATABASE_TOOL_NAMES } from "./database-tools.ts";
import { assertModelInLocalCatalog } from "./local-model-catalog.ts";

const MAX_PROMPT_LENGTH = 4_000;
const SESSION_ID_PATTERN = /^[A-Za-z0-9-]{8,100}$/u;
type SessionMessage = AgentSession["messages"][number];

export interface AgentSessionStoreOptions {
  readonly database: DemoDatabase;
  readonly cwd: string;
  readonly sessionDir: string;
  readonly agentDir: string;
  readonly model: ModelSelection;
}

interface SessionTimes {
  created: Date;
  modified: Date;
}

export class SessionNotFoundError extends Error {
  constructor(id: string) {
    super(`找不到会话 ${id}`);
    this.name = "SessionNotFoundError";
  }
}

export class SessionBusyError extends Error {
  constructor() {
    super("该会话正在回答，请等待完成或先停止当前回答");
    this.name = "SessionBusyError";
  }
}

function buildSystemPrompt(): string {
  return `你是一个严谨的数据库问答助手。你的任务是根据 SQLite 数据库中的真实数据回答用户问题。

规则：
1. 系统提示词不会提供数据库结构。需要了解表、视图或字段时，先调用 query_database 查询 sqlite_master、pragma_table_info 等 SQLite 元数据；不得猜测结构。
2. 涉及数据库事实、统计或明细时，必须调用 query_database 获取真实结果；不得凭空猜测数据。
3. 使用 SQLite 语法。优先执行范围明确、列名明确的查询，并明确说明统计口径。
4. 只有当用户在当前消息中明确要求新增、修改或删除数据时，才能调用 execute_database。不要执行隐含写入。
5. 写入后使用 query_database 验证结果。execute_database 不接受建表、删表或其他 DDL。
6. 回答使用中文，先给结论，再简洁说明口径。金额保留两位小数；没有数据时明确说明。
7. 不要声称自己访问了文件、终端或网络。你只有 query_database 和 execute_database 两个工具。`;
}

function createLockedResourceLoader(systemPrompt: string): ResourceLoader {
  return {
    getExtensions: () => ({ extensions: [], errors: [], runtime: createExtensionRuntime() }),
    getSkills: () => ({ skills: [], diagnostics: [] }),
    getPrompts: () => ({ prompts: [], diagnostics: [] }),
    getThemes: () => ({ themes: [], diagnostics: [] }),
    getAgentsFiles: () => ({ agentsFiles: [] }),
    getSystemPrompt: () => systemPrompt,
    getSystemPromptSource: () => undefined,
    getAppendSystemPrompt: () => [],
    getAppendSystemPromptSources: () => [],
    extendResources: () => {},
    reload: async () => {},
  };
}

function messageText(message: SessionMessage | undefined): string {
  if (!message || !("content" in message)) return "";
  const { content } = message;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => (part.type === "text" ? part.text : ""))
    .join("");
}

function serializeMessages(messages: readonly SessionMessage[]): ChatMessage[] {
  const transcript: ChatMessage[] = [];
  for (const message of messages) {
    if (message.role !== "user" && message.role !== "assistant") continue;
    const text = messageText(message) || (message.role === "assistant" ? message.errorMessage : "");
    if (!text?.trim()) continue;
    transcript.push({
      id: `${message.role}-${transcript.length + 1}`,
      role: message.role,
      text,
      ...(message.timestamp === undefined ? {} : { timestamp: message.timestamp }),
    });
  }
  return transcript;
}

function sessionTitle(session: AgentSession): string {
  const firstUserMessage = session.messages.find((message) => message.role === "user");
  return session.sessionName || messageText(firstUserMessage).trim() || "新会话";
}

function shortTitle(prompt: string): string {
  const normalized = prompt.replace(/\s+/gu, " ").trim();
  return Array.from(normalized).slice(0, 32).join("");
}

function isDatabaseToolName(name: string): name is DatabaseToolName {
  return DATABASE_TOOL_NAMES.some((expected) => expected === name);
}

function validatedDatabaseToolNames(names: readonly string[]): DatabaseToolName[] {
  if (
    names.length !== DATABASE_TOOL_NAMES.length ||
    names.some((name) => !isDatabaseToolName(name))
  ) {
    throw new Error(`Agent 工具白名单校验失败：${names.join(", ")}`);
  }
  return names.filter(isDatabaseToolName);
}

export class AgentSessionStore {
  readonly #database: DemoDatabase;
  readonly #cwd: string;
  readonly #sessionDir: string;
  readonly #agentDir: string;
  readonly #model: ModelSelection;
  readonly #sessions = new Map<string, AgentSession>();
  readonly #sessionTimes = new Map<string, SessionTimes>();
  readonly #modelRuntime: ModelRuntime;

  private constructor(
    { database, cwd, sessionDir, agentDir, model }: AgentSessionStoreOptions,
    modelRuntime: ModelRuntime,
  ) {
    this.#database = database;
    this.#cwd = cwd;
    this.#sessionDir = sessionDir;
    this.#agentDir = agentDir;
    this.#model = model;
    this.#modelRuntime = modelRuntime;
  }

  static async open(options: AgentSessionStoreOptions): Promise<AgentSessionStore> {
    const resolvedOptions: AgentSessionStoreOptions = {
      ...options,
      cwd: path.resolve(options.cwd),
      sessionDir: path.resolve(options.sessionDir),
      agentDir: path.resolve(options.agentDir),
    };
    mkdirSync(resolvedOptions.sessionDir, { recursive: true });
    mkdirSync(resolvedOptions.agentDir, { recursive: true });
    const modelsPath = path.join(resolvedOptions.agentDir, "models.json");
    const modelsStorePath = path.join(resolvedOptions.agentDir, "models-store.json");
    assertModelInLocalCatalog(resolvedOptions.agentDir, resolvedOptions.model);
    const modelRuntime = await ModelRuntime.create({
      authPath: path.join(resolvedOptions.agentDir, "auth.json"),
      modelsPath,
      modelsStorePath,
    });
    if (!modelRuntime.getModel(resolvedOptions.model.provider, resolvedOptions.model.model)) {
      throw new Error(
        `Pi 无法解析本地模型 ${resolvedOptions.model.provider}/${resolvedOptions.model.model}，请检查模型文件格式`,
      );
    }
    return new AgentSessionStore(resolvedOptions, modelRuntime);
  }

  async create(): Promise<SerializedSession> {
    const manager = SessionManager.create(this.#cwd, this.#sessionDir);
    const session = await this.#createPiSession(manager);
    // Pi persists a new session lazily on its first entry. Naming it here makes
    // the in-memory web session presentable before the first assistant response.
    session.setSessionName("新会话");
    this.#sessions.set(session.sessionId, session);
    const now = new Date();
    this.#sessionTimes.set(session.sessionId, { created: now, modified: now });
    return this.serialize(session);
  }

  async list(): Promise<SessionSummary[]> {
    const infos = await SessionManager.list(this.#cwd, this.#sessionDir);
    const listed = new Map<string, SessionSummary>(
      infos.map((info) => [info.id, {
        id: info.id,
        title: info.name || info.firstMessage || "新会话",
        createdAt: info.created.toISOString(),
        updatedAt: info.modified.toISOString(),
        messageCount: info.messageCount,
        active: this.#sessions.has(info.id),
      }]),
    );

    // Pi intentionally does not create the JSONL file until an assistant reply
    // exists. Merge active empty/new sessions so the web list remains one-to-one.
    for (const [id, session] of this.#sessions) {
      if (listed.has(id)) continue;
      const times = this.#sessionTimes.get(id) || { created: new Date(), modified: new Date() };
      listed.set(id, {
        id,
        title: sessionTitle(session),
        createdAt: times.created.toISOString(),
        updatedAt: times.modified.toISOString(),
        messageCount: serializeMessages(session.messages).length,
        active: true,
      });
    }

    return [...listed.values()].sort(
      (left, right) => new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime(),
    );
  }

  async get(id: string): Promise<AgentSession> {
    this.#assertValidId(id);
    const cached = this.#sessions.get(id);
    if (cached) return cached;

    const infos = await SessionManager.list(this.#cwd, this.#sessionDir);
    const info = infos.find((candidate) => candidate.id === id);
    if (!info) throw new SessionNotFoundError(id);
    const session = await this.#createPiSession(
      SessionManager.open(info.path, this.#sessionDir, this.#cwd),
    );
    this.#sessions.set(id, session);
    this.#sessionTimes.set(id, { created: info.created, modified: info.modified });
    return session;
  }

  async getSerialized(id: string): Promise<SerializedSession> {
    return this.serialize(await this.get(id));
  }

  async prompt(id: string, text: string): Promise<void> {
    if (typeof text !== "string" || !text.trim()) throw new TypeError("问题不能为空");
    if (text.length > MAX_PROMPT_LENGTH) {
      throw new TypeError(`问题不能超过 ${MAX_PROMPT_LENGTH} 个字符`);
    }
    const session = await this.get(id);
    if (session.isStreaming) throw new SessionBusyError();
    if (!session.sessionName || session.sessionName === "新会话") {
      session.setSessionName(shortTitle(text));
    }
    await session.prompt(text.trim(), { expandPromptTemplates: false });
    const times = this.#sessionTimes.get(id);
    if (times) times.modified = new Date();
  }

  async abort(id: string): Promise<void> {
    const session = await this.get(id);
    if (session.isStreaming) await session.abort();
  }

  serialize(session: AgentSession): SerializedSession {
    return {
      id: session.sessionId,
      title: sessionTitle(session),
      model: session.model
        ? { provider: session.model.provider, id: session.model.id, name: session.model.name }
        : null,
      tools: validatedDatabaseToolNames(session.getActiveToolNames()),
      streaming: session.isStreaming,
      messages: serializeMessages(session.messages),
    };
  }

  status(): AgentStatus {
    return {
      tools: [...DATABASE_TOOL_NAMES],
      model: this.#model,
      availableModelCount: this.#modelRuntime.getAvailableSnapshot().length,
      activeSessionCount: this.#sessions.size,
    };
  }

  dispose(): void {
    for (const session of this.#sessions.values()) session.dispose();
    this.#sessions.clear();
    this.#sessionTimes.clear();
  }

  async #createPiSession(sessionManager: SessionManager): Promise<AgentSession> {
    const settingsManager = SettingsManager.create(this.#cwd, this.#agentDir, { projectTrusted: false });
    const model = this.#modelRuntime.getModel(this.#model.provider, this.#model.model);
    if (!model) {
      throw new Error(
        `找不到模型 ${this.#model.provider}/${this.#model.model}，请检查 .env 与 ${this.#agentDir}`,
      );
    }

    const tools = createDatabaseTools(this.#database);
    const { session } = await createAgentSession({
      cwd: this.#cwd,
      agentDir: this.#agentDir,
      model,
      modelRuntime: this.#modelRuntime,
      settingsManager,
      sessionManager,
      resourceLoader: createLockedResourceLoader(buildSystemPrompt()),
      tools: [...DATABASE_TOOL_NAMES],
      customTools: tools,
      noTools: "builtin",
    });

    try {
      validatedDatabaseToolNames(session.getActiveToolNames());
    } catch (error) {
      session.dispose();
      throw error;
    }
    return session;
  }

  #assertValidId(id: string): void {
    if (!SESSION_ID_PATTERN.test(id)) throw new SessionNotFoundError(id);
  }

}
