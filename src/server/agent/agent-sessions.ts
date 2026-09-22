import { mkdirSync } from "node:fs";
import { unlink } from "node:fs/promises";
import path from "node:path";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  sessionEntryToContextMessages,
} from "@earendil-works/pi-coding-agent";
import type {
  AgentSession,
  AgentSessionEvent,
  ResourceLoader,
  SessionInfo,
} from "@earendil-works/pi-coding-agent";
import {
  isAgentToolName,
  type AgentToolName,
  type AgentStatus,
  type ChatImage,
  type ChatMessage,
  type ChatTraceItem,
  type DashboardEditRequest,
  type JsonObject,
  type ModelSelection,
  type SerializedSession,
  type SessionSummary,
} from "../../shared/contracts.ts";
import type { DashboardState } from "../../shared/dashboard.ts";
import type { AppDatabase } from "../database/database.ts";
import type { ArtifactStore } from "../tool/artifact-store.ts";
import type { CodeInterpreterRuntime } from "../tool/code-interpreter.ts";
import { extractCodeInterpreterImages } from "../tool/code-interpreter-images.ts";
import { activeAgentToolNames, createAgentTools } from "../tool/database-tools.ts";
import { createEmailTool, EMAIL_TOOL_NAME } from "../tool/email-tools.ts";
import type { EmailConfig } from "../email.ts";
import { SessionDashboardStore, type InitialDashboardProvider } from "./session-dashboard.ts";
import { assertModelInLocalCatalog } from "./local-model-catalog.ts";
import { createGeneratedTextReviewExtension } from "./generated-text-review.ts";
import { createDashboardContextExtension } from "./dashboard-context.ts";
import type { AppLogger } from "../logger.ts";
import {
  loadAgentSkillCatalog,
  SKILL_READ_TOOL_NAME,
  type AgentSkillCatalog,
} from "./skill-catalog.ts";
import { buildSystemPrompt, websiteInvestigationPrompt } from "./prompts.ts";
import { SubagentRunner, SUBAGENT_TOOL_NAME, SUBAGENT_AGENT_RULES } from "./subagent.ts";

const MAX_PROMPT_LENGTH = 4_000;
const SESSION_ID_PATTERN = /^[A-Za-z0-9-]{8,100}$/u;

export interface AgentSessionStoreOptions {
  readonly database: AppDatabase;
  readonly cwd: string;
  readonly sessionDir: string;
  readonly agentDir: string;
  readonly model: ModelSelection;
  readonly artifacts: ArtifactStore;
  readonly loadInitialDashboard: InitialDashboardProvider;
  readonly codeInterpreter: CodeInterpreterRuntime;
  readonly email?: EmailConfig | null;
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

async function createLockedResourceLoader(
  systemPrompt: string,
  skillCatalog: AgentSkillCatalog,
  cwd: string,
  agentDir: string,
  settingsManager: SettingsManager,
  logger: AgentProcessLogger,
  dashboard: SessionDashboardStore,
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
    extensionFactories: [
      skillCatalog.createSessionExtension(cwd),
      createGeneratedTextReviewExtension(logger),
      createDashboardContextExtension(dashboard, logger),
    ],
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

interface ToolCallSummary {
  readonly id: string;
  readonly name: string;
  readonly arguments: JsonObject;
}

interface ResponseAccumulator {
  readonly trace: ChatTraceItem[];
  readonly pendingToolTraceIndices: Map<string, number[]>;
  readonly toolImagesByTraceIndex: Map<number, readonly ChatImage[]>;
  hasFinal: boolean;
  finalText: string;
  finalTimestamp: number | undefined;
  fallbackText: string;
  fallbackTimestamp: number | undefined;
}

function contentParts(message: TranscriptSourceMessage): readonly unknown[] {
  return Array.isArray(message.content) ? message.content : [];
}

function normalizedToolArguments(value: unknown): JsonObject {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
  try {
    const serialized = JSON.stringify(value);
    if (serialized === undefined) return {};
    const parsed: unknown = JSON.parse(serialized);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? parsed as JsonObject
      : {};
  } catch {
    return {};
  }
}

function toolCallSummary(part: unknown): ToolCallSummary | null {
  if (
    typeof part !== "object" || part === null || !("type" in part) ||
    part.type !== "toolCall" || !("id" in part) || typeof part.id !== "string" ||
    !("name" in part) || typeof part.name !== "string"
  ) return null;
  return {
    id: part.id,
    name: part.name,
    arguments: normalizedToolArguments("arguments" in part ? part.arguments : undefined),
  };
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
    pendingToolTraceIndices: new Map(),
    toolImagesByTraceIndex: new Map(),
    hasFinal: false,
    finalText: "",
    finalTimestamp: undefined,
    fallbackText: "",
    fallbackTimestamp: undefined,
  };
}

function responseImages(response: ResponseAccumulator): ChatImage[] {
  const images: ChatImage[] = [];
  const imageIds = new Set<string>();
  const groups = [...response.toolImagesByTraceIndex.entries()]
    .sort(([left], [right]) => left - right);
  for (const [, group] of groups) {
    for (const image of group) {
      if (imageIds.has(image.id)) continue;
      imageIds.add(image.id);
      images.push(image);
    }
  }
  return images;
}

function applyToolResult(
  response: ResponseAccumulator,
  message: TranscriptSourceMessage,
): void {
  if (typeof message.toolCallId !== "string") return;
  const pending = response.pendingToolTraceIndices.get(message.toolCallId);
  if (!pending?.length) return;
  const matchAt = typeof message.toolName === "string"
    ? pending.findIndex((traceIndex) => {
        const item = response.trace[traceIndex];
        return item?.type === "tool" && item.name === message.toolName;
      })
    : 0;
  if (matchAt < 0) return;
  const [traceIndex] = pending.splice(matchAt, 1);
  if (traceIndex === undefined) return;
  if (!pending.length) response.pendingToolTraceIndices.delete(message.toolCallId);
  const item = response.trace[traceIndex];
  if (!item || item.type !== "tool") return;
  response.trace[traceIndex] = { ...item, isError: message.isError === true };
  const images = message.toolName === "code_interpreter" && message.isError !== true
    ? extractCodeInterpreterImages(message.toolCallId, message.details)
    : [];
  if (images.length) response.toolImagesByTraceIndex.set(traceIndex, images);
}

export function serializeMessages(messages: readonly TranscriptSourceMessage[]): ChatMessage[] {
  const transcript: ChatMessage[] = [];
  let response: ResponseAccumulator | null = null;
  const flushResponse = (): void => {
    if (!response) return;
    const text = response.hasFinal ? response.finalText : response.fallbackText;
    if (text.trim() || response.trace.length) {
      const timestamp = response.hasFinal
        ? response.finalTimestamp
        : response.fallbackTimestamp;
      const images = responseImages(response);
      transcript.push({
        id: `assistant-${transcript.length + 1}`,
        role: "assistant",
        text,
        ...(timestamp === undefined ? {} : { timestamp }),
        ...(response.trace.length ? { trace: response.trace } : {}),
        ...(images.length ? { images } : {}),
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
    if (message.role === "toolResult") {
      if (response) applyToolResult(response, message);
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
          const traceIndex = response.trace.length;
          response.trace.push({
            type: "tool",
            id: tool.id,
            name: tool.name,
            arguments: tool.arguments,
            isError: true,
          });
          const pending = response.pendingToolTraceIndices.get(tool.id) ?? [];
          pending.push(traceIndex);
          response.pendingToolTraceIndices.set(tool.id, pending);
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

export function serializeSessionTranscript(
  session: Pick<AgentSession, "sessionManager">,
): ChatMessage[] {
  const branchMessages = session.sessionManager.getBranch()
    .flatMap(sessionEntryToContextMessages);
  return serializeMessages(branchMessages);
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

function codeInterpreterRejectionMessage(message: string): string {
  return message.split("\n重试提示：", 1)[0] ?? message;
}

function codeInterpreterRejectionReason(result: unknown): string | undefined {
  if (result instanceof Error) {
    const message = codeInterpreterRejectionMessage(result.message);
    if (/已移除 input_json/u.test(message)) return "legacy_input_removed";
    if (/不再接收 query/u.test(message)) return "legacy_query_removed";
    if (/数据快照|可用快照/u.test(message)) return "snapshot_invalid";
    if (/emit_result/u.test(message)) return "structured_result_invalid";
    if (/user_input/u.test(message)) return "user_input_invalid";
    return "execution_failed";
  }
  if (typeof result !== "object" || result === null || !("content" in result) ||
      !Array.isArray(result.content)) return undefined;
  const text = codeInterpreterRejectionMessage(result.content
    .map((part) => (
      typeof part === "object" && part !== null && "text" in part && typeof part.text === "string"
        ? part.text
        : ""
    ))
    .join(" "));
  if (/已移除 input_json/u.test(text)) return "legacy_input_removed";
  if (/不再接收 query/u.test(text)) return "legacy_query_removed";
  if (/数据快照|可用快照/u.test(text)) return "snapshot_invalid";
  if (/emit_result/u.test(text)) return "structured_result_invalid";
  if (/user_input/u.test(text)) return "user_input_invalid";
  return text ? "execution_failed" : undefined;
}

function codeInterpreterLogFields(
  toolName: string,
  result: unknown,
): Readonly<Record<string, unknown>> {
  if (toolName !== "code_interpreter") return {};
  if (
    typeof result !== "object" || result === null || !("details" in result) ||
    typeof result.details !== "object" || result.details === null ||
    !("kind" in result.details) || result.details.kind !== "code_interpreter"
  ) {
    const rejectionReason = codeInterpreterRejectionReason(result);
    return rejectionReason === undefined ? {} : { rejectionReason };
  }
  const details = result.details;
  const stdoutBytes = "stdout" in details && typeof details.stdout === "string"
    ? Buffer.byteLength(details.stdout)
    : 0;
  const stderrBytes = "stderr" in details && typeof details.stderr === "string"
    ? Buffer.byteLength(details.stderr)
    : 0;
  const imageCount = "images" in details && Array.isArray(details.images) ? details.images.length : 0;
  const provenance = "provenance" in details && typeof details.provenance === "object" &&
      details.provenance !== null
    ? details.provenance
    : null;
  const rowCount = provenance && "rowCount" in provenance && typeof provenance.rowCount === "number"
    ? provenance.rowCount
    : undefined;
  const inputBytes = provenance && "byteCount" in provenance && typeof provenance.byteCount === "number"
    ? provenance.byteCount
    : undefined;
  const hasUserInput = provenance && "hasUserInput" in provenance &&
      typeof provenance.hasUserInput === "boolean"
    ? provenance.hasUserInput
    : undefined;
  const dataSource = provenance && "source" in provenance &&
      (provenance.source === "sqlite" || provenance.source === "none")
    ? provenance.source
    : undefined;
  return {
    stdoutBytes,
    stderrBytes,
    imageCount,
    ...(rowCount === undefined ? {} : { rowCount }),
    ...(inputBytes === undefined ? {} : { inputBytes }),
    ...(hasUserInput === undefined ? {} : { hasUserInput }),
    ...(dataSource === undefined ? {} : { dataSource }),
  };
}

export class AgentSessionStore {
  readonly #database: AppDatabase;
  readonly #cwd: string;
  readonly #sessionDir: string;
  readonly #agentDir: string;
  readonly #model: ModelSelection;
  readonly #artifacts: ArtifactStore;
  readonly #dashboard: SessionDashboardStore;
  readonly #codeInterpreter: CodeInterpreterRuntime;
  readonly #email: EmailConfig | null;
  readonly #toolNames: readonly AgentToolName[];
  readonly #skillCatalog: AgentSkillCatalog;
  readonly #sessions = new Map<string, AgentSession>();
  readonly #subagents = new Map<string, SubagentRunner>();
  readonly #sessionTimes = new Map<string, SessionTimes>();
  readonly #modelRuntime: ModelRuntime;
  readonly #logger: AgentProcessLogger;
  readonly #unsubscribers = new Map<string, () => void>();
  readonly #toolStartedAt = new Map<string, number>();
  readonly #activeRequestIds = new Map<string, string>();

  private constructor(
    { database, cwd, sessionDir, agentDir, model, artifacts, loadInitialDashboard, codeInterpreter, email, logger }:
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
    this.#dashboard = new SessionDashboardStore(artifacts, loadInitialDashboard);
    this.#codeInterpreter = codeInterpreter;
    this.#email = email ?? null;
    this.#toolNames = [SKILL_READ_TOOL_NAME, ...activeAgentToolNames(codeInterpreter, true), ...(this.#email ? [EMAIL_TOOL_NAME] : []), SUBAGENT_TOOL_NAME];
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
    this.#ensureDashboardMarker(manager);
    const session = await this.#createPiSession(manager);
    // Pi keeps entries in memory until the first assistant message, so naming
    // and marking an empty session do not create its JSONL file.
    session.setSessionName("新会话");
    this.#sessions.set(session.sessionId, session);
    const now = new Date();
    this.#sessionTimes.set(session.sessionId, { created: now, modified: now });
    this.#logger.info("agent.session.created", { sessionId: session.sessionId });
    return this.serialize(session);
  }

  async list(): Promise<SessionSummary[]> {
    const infos = await this.#listPersistedSessions();
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
        messageCount: serializeSessionTranscript(session).length,
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

    const infos = await this.#listPersistedSessions();
    const info = infos.find((candidate) => candidate.id === id);
    if (!info) throw new SessionNotFoundError(id);
    const session = await this.#createPiSession(
      this.#openInitializedManager(info.path),
    );
    this.#sessions.set(id, session);
    this.#sessionTimes.set(id, { created: info.created, modified: info.modified });
    this.#logger.info("agent.session.restored", { sessionId: id });
    return session;
  }

  async getSerialized(id: string): Promise<SerializedSession> {
    return this.serialize(await this.get(id));
  }

  async editDashboard(id: string, request: DashboardEditRequest): Promise<DashboardState> {
    const session = await this.get(id);
    if (session.isStreaming) throw new SessionBusyError();
    const result = this.#dashboard.apply(id, request.action === "remove"
      ? {
          action: "remove",
          baseRevision: request.baseRevision,
          widgetId: request.widgetId,
        }
      : {
          action: "reorder",
          baseRevision: request.baseRevision,
          widgetIds: request.widgetIds,
        });
    this.#logger.info("dashboard.edited", {
      sessionId: id,
      action: request.action,
      revision: result.dashboard.revision,
    });
    return result.dashboard;
  }

  async delete(id: string): Promise<void> {
    this.#assertValidId(id);
    const infos = await this.#listPersistedSessions();
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
    await this.#subagents.get(id)?.dispose();
    this.#subagents.delete(id);
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
    this.#dashboard.forget(id);
    this.#logger.info("agent.session.deleted", {
      sessionId: id,
      persisted: filePath !== null,
    });
  }

  async prompt(id: string, text: string, requestId?: string): Promise<void> {
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
    if (requestId) this.#activeRequestIds.set(id, requestId);
    this.#logger.info("agent.prompt.started", {
      sessionId: id,
      ...(requestId ? { requestId } : {}),
      promptLength: prompt.length,
    });
    try {
      await session.prompt(prompt, { expandPromptTemplates: false });
      const times = this.#sessionTimes.get(id);
      if (times) times.modified = new Date();
      this.#logger.info("agent.prompt.completed", {
        sessionId: id,
        ...(requestId ? { requestId } : {}),
        durationMs: Date.now() - startedAt,
      });
    } catch (error) {
      this.#logger.error("agent.prompt.failed", error, {
        sessionId: id,
        ...(requestId ? { requestId } : {}),
        durationMs: Date.now() - startedAt,
      });
      throw error;
    } finally {
      this.#activeRequestIds.delete(id);
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
    // AgentSession.messages is the compaction-aware LLM context. Rebuild the
    // transcript from the raw active branch so loading history never hides
    // messages that were summarized out of the model context.
    const messages = serializeSessionTranscript(session);
    return {
      id: session.sessionId,
      title: sessionTitle(session),
      model: session.model
        ? { provider: session.model.provider, id: session.model.id, name: session.model.name }
        : null,
      tools: validatedAgentToolNames(session),
      streaming: session.isStreaming,
      messages,
      dashboard: messages.length === 0
        ? this.#dashboard.loadOrPreview(session.sessionId)
        : this.#dashboard.loadOrInitialize(session.sessionId),
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

  async dispose(): Promise<void> {
    this.#logger.info("agent.store.disposing", { activeSessionCount: this.#sessions.size });
    for (const unsubscribe of this.#unsubscribers.values()) unsubscribe();
    for (const session of this.#sessions.values()) session.dispose();
    this.#unsubscribers.clear();
    this.#toolStartedAt.clear();
    this.#activeRequestIds.clear();
    this.#sessions.clear();
    this.#sessionTimes.clear();
    await Promise.all([...this.#subagents.values()].map((runner) => runner.dispose()));
    this.#subagents.clear();
    this.#dashboard.dispose();
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
    let parent: AgentSession;
    const subagents = new SubagentRunner({
      cwd: this.#cwd, agentDir: this.#agentDir, catalog: this.#skillCatalog, parent: () => parent,
      onEvent: (event) => this.#logger.info("agent.subagent.event", {
        ...event, sessionId: sessionManager.getSessionId(), requestId: this.#activeRequestIds.get(sessionManager.getSessionId()),
      }),
      prepareBatch: () => {
        let dashboard: unknown;
        try { dashboard = { status: "available", dashboard: this.#dashboard.loadOrPreview(sessionManager.getSessionId()) }; }
        catch (error) {
          this.#logger.error("agent.subagent.dashboard.failed", error, { sessionId: sessionManager.getSessionId() });
          dashboard = { status: "unavailable", message: "当前看板不可用，不得猜测展示内容" };
        }
        return (agentId) => ({
          systemPrompt: websiteInvestigationPrompt(),
          tools: createAgentTools(this.#database, artifacts.scoped(agentId), this.#codeInterpreter, new Set(), undefined, true),
          context: () => ({ dashboard, snapshots: artifacts.listDataSnapshots() }),
        });
      },
    });
    const usedGeneratedImageIds = new Set<string>();
    for (const entry of sessionManager.getEntries()) {
      if (
        entry.type !== "message" || entry.message.role !== "toolResult" ||
        entry.message.toolName !== "code_interpreter" || entry.message.isError === true
      ) continue;
      for (const image of extractCodeInterpreterImages(
        entry.message.toolCallId,
        entry.message.details,
      )) {
        usedGeneratedImageIds.add(image.id);
      }
    }
    const tools = [...createAgentTools(
      this.#database,
      artifacts,
      this.#codeInterpreter,
      usedGeneratedImageIds,
      { dashboard: this.#dashboard, sessionId: sessionManager.getSessionId() },
    ), ...(this.#email ? [createEmailTool(this.#email, this.#logger, sessionManager.getSessionId())] : []), subagents.createTool()];
    const resourceLoader = await createLockedResourceLoader(
      buildSystemPrompt(this.#codeInterpreter.status.available, this.#email !== null) + SUBAGENT_AGENT_RULES,
      this.#skillCatalog,
      this.#cwd,
      this.#agentDir,
      settingsManager,
      this.#logger,
      this.#dashboard,
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
    parent = session;

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
    this.#subagents.set(session.sessionId, subagents);
    return session;
  }

  #logAgentEvent(sessionId: string, event: AgentSessionEvent): void {
    const requestId = this.#activeRequestIds.get(sessionId);
    const common = { sessionId, ...(requestId ? { requestId } : {}) };
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
        ...codeInterpreterLogFields(event.toolName, event.result),
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

  async #listPersistedSessions(): Promise<SessionInfo[]> {
    // The configured session directory belongs to this application instance. A copied
    // project keeps its JSONL files but gets a new absolute cwd, so filtering by the
    // cwd stored in each session header would make otherwise valid history disappear.
    return SessionManager.listAll(this.#sessionDir);
  }

  #openInitializedManager(filePath: string): SessionManager {
    const manager = SessionManager.open(filePath, this.#sessionDir, this.#cwd);
    this.#ensureDashboardMarker(manager);
    return manager;
  }

  #ensureDashboardMarker(manager: SessionManager): void {
    const hasMarker = manager.getEntries().some((entry) => (
      entry.type === "custom" && entry.customType === "datalens_dashboard_v1"
    ));
    if (!hasMarker) manager.appendCustomEntry("datalens_dashboard_v1", { schemaVersion: 1 });
  }

}
