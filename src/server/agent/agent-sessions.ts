import { mkdirSync } from "node:fs";
import { unlink } from "node:fs/promises";
import path from "node:path";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import type {
  AgentSession,
  AgentSessionEvent,
  ResourceLoader,
} from "@earendil-works/pi-coding-agent";
import {
  isAgentToolName,
  type AgentToolName,
  type AgentStatus,
  type ChatImage,
  type ChatMessage,
  type ChatTraceItem,
  type ModelSelection,
  type SerializedSession,
  type SessionSummary,
} from "../../shared/contracts.ts";
import type { AppDatabase } from "../database/database.ts";
import type { ArtifactStore } from "../tool/artifact-store.ts";
import type { CodeInterpreterRuntime } from "../tool/code-interpreter.ts";
import { activeAgentToolNames, createAgentTools } from "../tool/database-tools.ts";
import { assertModelInLocalCatalog } from "./local-model-catalog.ts";
import type { AppLogger } from "../logger.ts";
import {
  loadAgentSkillCatalog,
  SKILL_READ_TOOL_NAME,
  type AgentSkillCatalog,
} from "./skill-catalog.ts";

const MAX_PROMPT_LENGTH = 4_000;
const SESSION_ID_PATTERN = /^[A-Za-z0-9-]{8,100}$/u;

export interface AgentSessionStoreOptions {
  readonly database: AppDatabase;
  readonly cwd: string;
  readonly sessionDir: string;
  readonly agentDir: string;
  readonly model: ModelSelection;
  readonly artifacts: ArtifactStore;
  readonly codeInterpreter: CodeInterpreterRuntime;
  readonly logger?: AgentProcessLogger;
}

type AgentProcessLogger = Pick<AppLogger, "info" | "warn" | "error">;

export interface TranscriptSourceMessage {
  readonly role: string;
  readonly content?: unknown;
  readonly timestamp?: number;
  readonly errorMessage?: string;
  readonly stopReason?: string;
  readonly toolCallId?: string;
  readonly toolName?: string;
  readonly isError?: boolean;
  readonly details?: unknown;
}

const NOOP_LOGGER: AgentProcessLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
};

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
    super("该会话正在回答,请等待完成或先停止当前回答");
    this.name = "SessionBusyError";
  }
}

function buildSystemPrompt(codeInterpreterAvailable: boolean): string {
  const codeInterpreterRules = codeInterpreterAvailable
    ? `
8. 少量查询结果优先使用 execute_sql 的默认 inline 模式。需要对大量明细做额外计算或渲染时,使用 output_format="json_file",再把返回的 fileUri 原样传给 code_interpreter.input_json。
9. 只有 SQL 和当前时间工具无法完成精确计算、统计方法或 PNG 渲染时才调用 code_interpreter。
10. code_interpreter 是禁网且与项目隔离的临时沙箱,不得尝试访问 SQLite、项目文件、任意宿主路径或安装依赖。
11. emit_image() 生成的 PNG 会由前端自动附加并持久化。回答中不得虚构 artifact://image.png、sandbox 路径或其他 Markdown 图片地址。`
    : "";
  return `你是一个严谨的数据库问答助手。你的任务是根据 SQLite 数据库中的真实数据回答用户问题。

规则:
1. 数据库结构和字段含义由适用的 Skill 提供。生成查询前必须读取该 Skill 指定的数据库参考文档,并严格使用其中的表和字段,不得猜测不存在的结构。
2. 涉及数据库事实、统计或明细时,必须调用最合适的已加载工具获取真实结果,不得凭空猜测数据。
3. 使用 SQLite 语法。优先执行范围明确、列名明确的查询,并明确说明统计口径。
4. execute_sql 只允许执行一条会返回结果集的只读 SQL;不得尝试新增、修改、删除数据或执行 DDL。
5. 用户询问当前日期、时间或相对时间范围时,先调用 get_current_time 获取真实的当前时间。
6. 回答使用中文,先给结论,再简洁说明口径。比率说明分子与分母;没有数据时明确说明。
7. 不要声称自己访问了未由工具提供的文件、终端或网络。只能使用当前会话已注册并启用的工具。${codeInterpreterRules}`;
}

async function createLockedResourceLoader(
  systemPrompt: string,
  skillCatalog: AgentSkillCatalog,
  cwd: string,
  agentDir: string,
  settingsManager: SettingsManager,
): Promise<ResourceLoader> {
  const loader = new DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    systemPrompt,
    extensionFactories: [skillCatalog.createSessionExtension(cwd)],
    skillsOverride: () => skillCatalog.resources,
  });
  await loader.reload();
  const extensionErrors = loader.getExtensions().errors;
  if (extensionErrors.length) {
    throw new Error(extensionErrors.map((error) => `${error.path}:${error.error}`).join("\n"));
  }
  return loader;
}

function messageText(message: TranscriptSourceMessage | undefined): string {
  if (!message || !("content" in message)) return "";
  const { content } = message;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => (
      typeof part === "object" && part !== null && "type" in part && part.type === "text" &&
        "text" in part && typeof part.text === "string"
        ? part.text
        : ""
    ))
    .join("");
}

function codeInterpreterImages(message: TranscriptSourceMessage): ChatImage[] {
  if (message.toolName !== "code_interpreter") return [];
  const details = message.details;
  if (
    typeof details !== "object" || details === null || !("kind" in details) ||
    details.kind !== "code_interpreter" || !("images" in details) || !Array.isArray(details.images)
  ) return [];
  const images: ChatImage[] = [];
  for (const candidate of details.images.slice(0, 3)) {
    if (
      typeof candidate !== "object" || candidate === null ||
      !("mimeType" in candidate) || candidate.mimeType !== "image/png" ||
      !("data" in candidate) || typeof candidate.data !== "string" ||
      !("alt" in candidate) || typeof candidate.alt !== "string" ||
      candidate.data.length > 2_800_000
    ) continue;
    const bytes = Buffer.from(candidate.data, "base64");
    if (
      bytes.length > 2 * 1024 * 1024 || bytes.length < 8 ||
      bytes.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a"
    ) continue;
    images.push({ mimeType: "image/png", data: candidate.data, alt: candidate.alt });
  }
  return images;
}

interface ToolCallSummary {
  readonly id: string;
  readonly name: string;
}

interface ResponseAccumulator {
  readonly trace: ChatTraceItem[];
  readonly images: ChatImage[];
  hasFinal: boolean;
  finalText: string;
  finalTimestamp: number | undefined;
  fallbackText: string;
  fallbackTimestamp: number | undefined;
}

function contentParts(message: TranscriptSourceMessage): readonly unknown[] {
  return Array.isArray(message.content) ? message.content : [];
}

function toolCallSummary(part: unknown): ToolCallSummary | null {
  if (
    typeof part !== "object" || part === null || !("type" in part) ||
    part.type !== "toolCall" || !("id" in part) || typeof part.id !== "string" ||
    !("name" in part) || typeof part.name !== "string"
  ) return null;
  return { id: part.id, name: part.name };
}

function appendTraceText(trace: ChatTraceItem[], text: string): void {
  if (!text) return;
  const previous = trace.at(-1);
  if (previous?.type === "text") {
    trace[trace.length - 1] = { type: "text", text: previous.text + text };
  } else {
    trace.push({ type: "text", text });
  }
}

function newResponseAccumulator(): ResponseAccumulator {
  return {
    trace: [],
    images: [],
    hasFinal: false,
    finalText: "",
    finalTimestamp: undefined,
    fallbackText: "",
    fallbackTimestamp: undefined,
  };
}

export function serializeMessages(messages: readonly TranscriptSourceMessage[]): ChatMessage[] {
  const transcript: ChatMessage[] = [];
  const toolErrors = new Map<string, boolean>();
  const toolImages = new Map<string, readonly ChatImage[]>();
  for (const message of messages) {
    if (message.role === "toolResult" && typeof message.toolCallId === "string") {
      toolErrors.set(message.toolCallId, message.isError === true);
      const images = codeInterpreterImages(message);
      if (images.length) toolImages.set(message.toolCallId, images);
    }
  }

  let response: ResponseAccumulator | null = null;
  const flushResponse = (): void => {
    if (!response) return;
    const text = response.hasFinal ? response.finalText : response.fallbackText;
    if (text.trim() || response.trace.length) {
      const timestamp = response.hasFinal
        ? response.finalTimestamp
        : response.fallbackTimestamp;
      transcript.push({
        id: `assistant-${transcript.length + 1}`,
        role: "assistant",
        text,
        ...(timestamp === undefined ? {} : { timestamp }),
        ...(response.trace.length ? { trace: response.trace } : {}),
        ...(response.images.length ? { images: response.images } : {}),
      });
    }
    response = null;
  };

  for (const message of messages) {
    if (message.role === "user") {
      flushResponse();
      const text = messageText(message);
      if (!text.trim()) continue;
      transcript.push({
        id: `user-${transcript.length + 1}`,
        role: "user",
        text,
        ...(message.timestamp === undefined ? {} : { timestamp: message.timestamp }),
      });
      response = newResponseAccumulator();
      continue;
    }
    if (message.role !== "assistant" || !response) continue;

    const parts = contentParts(message);
    const toolCalls = parts.map(toolCallSummary).filter((tool): tool is ToolCallSummary => tool !== null);
    const text = messageText(message);
    const successfulFinal = toolCalls.length === 0 &&
      (message.stopReason === "stop" || message.stopReason === "length");
    if (successfulFinal) {
      response.hasFinal = true;
      response.finalText = text;
      response.finalTimestamp = message.timestamp;
      continue;
    }
    if (toolCalls.length) {
      for (const part of parts) {
        const tool = toolCallSummary(part);
        if (tool) {
          response.trace.push({
            type: "tool",
            id: tool.id,
            name: tool.name,
            isError: toolErrors.get(tool.id) ?? true,
          });
          response.images.push(...(toolImages.get(tool.id) ?? []));
        } else if (
          typeof part === "object" && part !== null && "type" in part && part.type === "text" &&
          "text" in part && typeof part.text === "string"
        ) {
          appendTraceText(response.trace, part.text);
        }
      }
      continue;
    }
    const fallback = text || message.errorMessage || "";
    if (fallback.trim()) {
      response.fallbackText = fallback;
      response.fallbackTimestamp = message.timestamp;
    }
  }
  flushResponse();
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

function validatedAgentToolNames(
  session: AgentSession,
): AgentToolName[] {
  const names = session.getActiveToolNames();
  if (
    new Set(names).size !== names.length ||
    names.some((name) => !isAgentToolName(name) || session.getToolDefinition(name) === undefined)
  ) {
    throw new Error(`Agent 工具注册表校验失败:${names.join(", ")}`);
  }
  return names.filter(isAgentToolName);
}

function errorHasCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

function codeInterpreterLogFields(result: unknown): Readonly<Record<string, unknown>> {
  if (
    typeof result !== "object" || result === null || !("details" in result) ||
    typeof result.details !== "object" || result.details === null ||
    !("kind" in result.details) || result.details.kind !== "code_interpreter"
  ) return {};
  const details = result.details;
  const stdoutBytes = "stdout" in details && typeof details.stdout === "string"
    ? Buffer.byteLength(details.stdout)
    : 0;
  const stderrBytes = "stderr" in details && typeof details.stderr === "string"
    ? Buffer.byteLength(details.stderr)
    : 0;
  const imageCount = "images" in details && Array.isArray(details.images) ? details.images.length : 0;
  return { stdoutBytes, stderrBytes, imageCount };
}

export class AgentSessionStore {
  readonly #database: AppDatabase;
  readonly #cwd: string;
  readonly #sessionDir: string;
  readonly #agentDir: string;
  readonly #model: ModelSelection;
  readonly #artifacts: ArtifactStore;
  readonly #codeInterpreter: CodeInterpreterRuntime;
  readonly #toolNames: readonly AgentToolName[];
  readonly #skillCatalog: AgentSkillCatalog;
  readonly #sessions = new Map<string, AgentSession>();
  readonly #sessionTimes = new Map<string, SessionTimes>();
  readonly #modelRuntime: ModelRuntime;
  readonly #logger: AgentProcessLogger;
  readonly #unsubscribers = new Map<string, () => void>();
  readonly #toolStartedAt = new Map<string, number>();

  private constructor(
    { database, cwd, sessionDir, agentDir, model, artifacts, codeInterpreter, logger }:
      AgentSessionStoreOptions,
    modelRuntime: ModelRuntime,
    skillCatalog: AgentSkillCatalog,
  ) {
    this.#database = database;
    this.#cwd = cwd;
    this.#sessionDir = sessionDir;
    this.#agentDir = agentDir;
    this.#model = model;
    this.#artifacts = artifacts;
    this.#codeInterpreter = codeInterpreter;
    this.#toolNames = [SKILL_READ_TOOL_NAME, ...activeAgentToolNames(codeInterpreter)];
    this.#skillCatalog = skillCatalog;
    this.#modelRuntime = modelRuntime;
    this.#logger = logger ?? NOOP_LOGGER;
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
        `Pi 无法解析本地模型 ${resolvedOptions.model.provider}/${resolvedOptions.model.model},请检查模型文件格式`,
      );
    }
    const skillCatalog = await loadAgentSkillCatalog();
    const store = new AgentSessionStore(resolvedOptions, modelRuntime, skillCatalog);
    store.#logger.info("agent.store.opened", {
      provider: resolvedOptions.model.provider,
      model: resolvedOptions.model.model,
      sessionDir: resolvedOptions.sessionDir,
    });
    return store;
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
    this.#logger.info("agent.session.created", { sessionId: session.sessionId });
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
    this.#logger.info("agent.session.restored", { sessionId: id });
    return session;
  }

  async getSerialized(id: string): Promise<SerializedSession> {
    return this.serialize(await this.get(id));
  }

  async delete(id: string): Promise<void> {
    this.#assertValidId(id);
    const infos = await SessionManager.list(this.#cwd, this.#sessionDir);
    const info = infos.find((candidate) => candidate.id === id);
    const session = this.#sessions.get(id);
    if (!info && !session) throw new SessionNotFoundError(id);
    if (session?.isStreaming) throw new SessionBusyError();

    const filePath = info ? path.resolve(info.path) : null;
    if (filePath) {
      const relativePath = path.relative(this.#sessionDir, filePath);
      if (
        !relativePath || relativePath === ".." ||
        relativePath.startsWith(`..${path.sep}`) || path.isAbsolute(relativePath)
      ) {
        throw new Error(`会话文件不在持久化目录中:${filePath}`);
      }
    }
    const unsubscribe = this.#unsubscribers.get(id);
    if (unsubscribe) unsubscribe();
    session?.dispose();
    this.#unsubscribers.delete(id);
    this.#sessions.delete(id);
    this.#sessionTimes.delete(id);
    for (const key of this.#toolStartedAt.keys()) {
      if (key.startsWith(`${id}:`)) this.#toolStartedAt.delete(key);
    }

    if (filePath) {
      try {
        await unlink(filePath);
      } catch (error) {
        if (!errorHasCode(error, "ENOENT")) throw error;
      }
    }
    await this.#artifacts.deleteSession(id);
    this.#logger.info("agent.session.deleted", {
      sessionId: id,
      persisted: filePath !== null,
    });
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
    const prompt = text.trim();
    const startedAt = Date.now();
    this.#logger.info("agent.prompt.started", {
      sessionId: id,
      promptLength: prompt.length,
    });
    try {
      await session.prompt(prompt, { expandPromptTemplates: false });
      const times = this.#sessionTimes.get(id);
      if (times) times.modified = new Date();
      this.#logger.info("agent.prompt.completed", {
        sessionId: id,
        durationMs: Date.now() - startedAt,
      });
    } catch (error) {
      this.#logger.error("agent.prompt.failed", error, {
        sessionId: id,
        durationMs: Date.now() - startedAt,
      });
      throw error;
    }
  }

  async abort(id: string): Promise<void> {
    const session = await this.get(id);
    if (!session.isStreaming) return;
    this.#logger.warn("agent.abort.requested", { sessionId: id });
    await session.abort();
    this.#logger.info("agent.abort.completed", { sessionId: id });
  }

  serialize(session: AgentSession): SerializedSession {
    return {
      id: session.sessionId,
      title: sessionTitle(session),
      model: session.model
        ? { provider: session.model.provider, id: session.model.id, name: session.model.name }
        : null,
      tools: validatedAgentToolNames(session),
      streaming: session.isStreaming,
      messages: serializeMessages(session.messages),
    };
  }

  status(): AgentStatus {
    return {
      tools: [...this.#toolNames],
      codeInterpreter: this.#codeInterpreter.status,
      model: this.#model,
      availableModelCount: this.#modelRuntime.getAvailableSnapshot().length,
      activeSessionCount: this.#sessions.size,
    };
  }

  dispose(): void {
    this.#logger.info("agent.store.disposing", { activeSessionCount: this.#sessions.size });
    for (const unsubscribe of this.#unsubscribers.values()) unsubscribe();
    for (const session of this.#sessions.values()) session.dispose();
    this.#unsubscribers.clear();
    this.#toolStartedAt.clear();
    this.#sessions.clear();
    this.#sessionTimes.clear();
    this.#codeInterpreter.dispose();
  }

  async #createPiSession(sessionManager: SessionManager): Promise<AgentSession> {
    const settingsManager = SettingsManager.create(this.#cwd, this.#agentDir, { projectTrusted: false });
    const model = this.#modelRuntime.getModel(this.#model.provider, this.#model.model);
    if (!model) {
      throw new Error(
        `找不到模型 ${this.#model.provider}/${this.#model.model},请检查 .env 与 ${this.#agentDir}`,
      );
    }

    const artifacts = this.#artifacts.forSession(sessionManager.getSessionId());
    const tools = createAgentTools(this.#database, artifacts, this.#codeInterpreter);
    const resourceLoader = await createLockedResourceLoader(
      buildSystemPrompt(this.#codeInterpreter.status.available),
      this.#skillCatalog,
      this.#cwd,
      this.#agentDir,
      settingsManager,
    );
    const { session } = await createAgentSession({
      cwd: this.#cwd,
      agentDir: this.#agentDir,
      model,
      modelRuntime: this.#modelRuntime,
      settingsManager,
      sessionManager,
      resourceLoader,
      customTools: tools,
      noTools: "builtin",
    });

    try {
      await session.bindExtensions({
        mode: "print",
        onError: (error) => this.#logger.error(
          "agent.extension.failed",
          new Error(error.error),
          { extensionPath: error.extensionPath, event: error.event },
        ),
      });
      validatedAgentToolNames(session);
    } catch (error) {
      session.dispose();
      throw error;
    }
    const unsubscribe = session.subscribe((event) => this.#logAgentEvent(session.sessionId, event));
    this.#unsubscribers.set(session.sessionId, unsubscribe);
    return session;
  }

  #logAgentEvent(sessionId: string, event: AgentSessionEvent): void {
    const common = { sessionId };
    if (event.type === "agent_start") {
      this.#logger.info("agent.run.started", common);
    } else if (event.type === "turn_start") {
      this.#logger.info("agent.turn.started", common);
    } else if (event.type === "turn_end") {
      this.#logger.info("agent.turn.completed", {
        ...common,
        toolResultCount: event.toolResults.length,
      });
    } else if (event.type === "tool_execution_start") {
      const key = `${sessionId}:${event.toolCallId}`;
      this.#toolStartedAt.set(key, Date.now());
      this.#logger.info("agent.tool.started", {
        ...common,
        toolCallId: event.toolCallId,
        toolName: event.toolName,
      });
    } else if (event.type === "tool_execution_end") {
      const key = `${sessionId}:${event.toolCallId}`;
      const startedAt = this.#toolStartedAt.get(key);
      this.#toolStartedAt.delete(key);
      const fields = {
        ...common,
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        isError: event.isError,
        ...codeInterpreterLogFields(event.result),
        ...(startedAt === undefined ? {} : { durationMs: Date.now() - startedAt }),
      };
      if (event.isError) this.#logger.warn("agent.tool.completed", fields);
      else this.#logger.info("agent.tool.completed", fields);
    } else if (event.type === "auto_retry_start") {
      this.#logger.warn("agent.retry.started", {
        ...common,
        attempt: event.attempt,
        maxAttempts: event.maxAttempts,
        delayMs: event.delayMs,
        errorMessage: event.errorMessage,
      });
    } else if (event.type === "auto_retry_end") {
      const fields = {
        ...common,
        attempt: event.attempt,
        success: event.success,
        ...(event.finalError ? { finalError: event.finalError } : {}),
      };
      if (event.success) this.#logger.info("agent.retry.completed", fields);
      else this.#logger.warn("agent.retry.completed", fields);
    } else if (event.type === "compaction_start") {
      this.#logger.info("agent.compaction.started", { ...common, reason: event.reason });
    } else if (event.type === "compaction_end") {
      this.#logger.info("agent.compaction.completed", {
        ...common,
        reason: event.reason,
        aborted: event.aborted,
        willRetry: event.willRetry,
      });
    } else if (event.type === "agent_end") {
      this.#logger.info("agent.run.completed", {
        ...common,
        messageCount: event.messages.length,
        willRetry: event.willRetry,
      });
    } else if (event.type === "agent_settled") {
      this.#logger.info("agent.run.settled", common);
    }
  }

  #assertValidId(id: string): void {
    if (!SESSION_ID_PATTERN.test(id)) throw new SessionNotFoundError(id);
  }

}
