import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import http from "node:http";
import type { IncomingMessage, OutgoingHttpHeaders, Server, ServerResponse } from "node:http";
import path from "node:path";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import type {
  AbortResponse,
  AgentStatus,
  AutomaticCompactionReason,
  ChatCompletionRequest,
  ChatCompletionResponse,
  CompactionOutcome,
  DeleteSessionResponse,
  ErrorResponse,
  HealthResponse,
  JsonObject,
  JsonResponseBody,
  MessageRequest,
  SchemaResponse,
  SchemaObject,
  SerializedSession,
  SessionSummary,
  SessionsResponse,
  SseEventMap,
} from "../shared/contracts.ts";
import {
  SessionBusyError, SessionNotFoundError, validatePromptText,
  type ChatCompletionOptions,
} from "./agent/agent-sessions.ts";
import { DatabaseInputError } from "./database/database.ts";
import { isDashboardUpdateDetails } from "./tool/dashboard-tools.ts";
import { DashboardInputError } from "./agent/session-dashboard.ts";
import { DASHBOARD_ID_PATTERN } from "../shared/dashboard.ts";
import { Authentication, AuthError } from "./auth.ts";

const MAX_BODY_BYTES = 64 * 1024;
type StaticFileRoot = "public" | "vendor";

interface StaticFile {
  readonly root: StaticFileRoot;
  readonly filename: string;
  readonly contentType: string;
}

const STATIC_FILES = new Map<string, StaticFile>([
  ["/", { root: "public", filename: "index.html", contentType: "text/html; charset=utf-8" }],
  ["/app.js", { root: "public", filename: "generated/client/app.js", contentType: "text/javascript; charset=utf-8" }],
  ["/api-contracts.js", { root: "public", filename: "generated/client/api-contracts.js", contentType: "text/javascript; charset=utf-8" }],
  ["/dashboard.js", { root: "public", filename: "generated/client/dashboard.js", contentType: "text/javascript; charset=utf-8" }],
  ["/shared/contracts.js", { root: "public", filename: "generated/shared/contracts.js", contentType: "text/javascript; charset=utf-8" }],
  ["/shared/dashboard.js", { root: "public", filename: "generated/shared/dashboard.js", contentType: "text/javascript; charset=utf-8" }],
  ["/shared/number-format.js", { root: "public", filename: "generated/shared/number-format.js", contentType: "text/javascript; charset=utf-8" }],
  ["/markdown-parser.js", { root: "public", filename: "generated/client/markdown-parser.js", contentType: "text/javascript; charset=utf-8" }],
  ["/markdown.js", { root: "public", filename: "generated/client/markdown.js", contentType: "text/javascript; charset=utf-8" }],
  ["/stream-state.js", { root: "public", filename: "generated/client/stream-state.js", contentType: "text/javascript; charset=utf-8" }],
  ["/styles.css", { root: "public", filename: "styles.css", contentType: "text/css; charset=utf-8" }],
  ["/vendor/marked.js", { root: "vendor", filename: "marked/lib/marked.umd.js", contentType: "text/javascript; charset=utf-8" }],
  ["/vendor/dompurify.js", { root: "vendor", filename: "dompurify/dist/purify.min.js", contentType: "text/javascript; charset=utf-8" }],
  ["/vendor/echarts.js", { root: "vendor", filename: "echarts/dist/echarts.min.js", contentType: "text/javascript; charset=utf-8" }],
]);

interface Logger {
  info?(event: string, fields?: Readonly<Record<string, unknown>>): void;
  warn?(event: string, fields?: Readonly<Record<string, unknown>>): void;
  error(
    event: string,
    error: unknown,
    fields?: Readonly<Record<string, unknown>>,
  ): void;
  child?(context: Readonly<Record<string, string | number | boolean>>): Logger;
}

export interface WebSessionPort {
  forAccount(account: string): ScopedSessionPort;
  status(): AgentStatus;
  list(): Promise<SessionSummary[]>;
  create(): Promise<SerializedSession>;
  get(id: string): Promise<StreamableAgentSession>;
  getSerialized(id: string): Promise<SerializedSession>;
  delete(id: string): Promise<void>;
  prompt(id: string, text: string, requestId?: string, dashboardId?: string): Promise<void>;
  complete(text: string, options?: ChatCompletionOptions): Promise<string>;
  abort(id: string): Promise<void>;
}

export interface ScopedSessionPort extends Omit<WebSessionPort, "forAccount" | "status" | "complete"> {
  fork(id: string): Promise<SerializedSession>;
}

export interface WebDatabasePort {
  readonly filePath: string;
  getSchema(): readonly SchemaObject[];
}

export interface StreamableAgentSession {
  readonly isStreaming: boolean;
  subscribe(listener: (event: AgentSessionEvent) => void): () => void;
}

export interface WebServerOptions {
  authentication?: Authentication;
  dashboardForAccount?: (account: string) => readonly string[];
  database: WebDatabasePort;
  sessions: WebSessionPort;
  publicDir: string;
  vendorDir: string;
  logger?: Logger;
}

class HttpError extends Error {
  readonly statusCode: number;

  constructor(message: string, statusCode: number) {
    super(message);
    this.name = "HttpError";
    this.statusCode = statusCode;
  }
}

function securityHeaders(contentType: string): OutgoingHttpHeaders {
  return {
    "Content-Type": contentType,
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "X-Frame-Options": "DENY",
    "Content-Security-Policy":
      "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; font-src 'self'; base-uri 'none'; frame-ancestors 'none'",
  };
}

function json(response: ServerResponse, status: number, value: JsonResponseBody): void {
  response.writeHead(status, securityHeaders("application/json; charset=utf-8"));
  response.end(JSON.stringify(value));
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const contentType = request.headers["content-type"] || "";
  if (!contentType.toLowerCase().startsWith("application/json")) {
    throw new HttpError("请求 Content-Type 必须是 application/json", 415);
  }

  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of request.iterator({ destroyOnReturn: false })) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) {
      request.resume();
      throw new HttpError("请求体过大", 413);
    }
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  try {
    const value: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
    return value;
  } catch {
    throw new HttpError("请求体不是有效 JSON", 400);
  }
}

function requireMessageRequest(value: unknown): MessageRequest {
  if (
    typeof value !== "object" ||
    value === null ||
    !("message" in value) ||
    typeof value.message !== "string"
  ) {
    throw new HttpError("请求体必须包含字符串类型的 message", 400);
  }
  if (!("dashboardId" in value) || typeof value.dashboardId !== "string" || !DASHBOARD_ID_PATTERN.test(value.dashboardId)) {
    throw new HttpError("dashboardId 必须是合法的看板 ID", 400);
  }
  return { message: value.message, dashboardId: value.dashboardId };
}

function requireChatCompletionRequest(value: unknown): ChatCompletionRequest {
  if (
    typeof value !== "object" || value === null || Array.isArray(value) ||
    !("text" in value) || typeof value.text !== "string"
  ) {
    throw new HttpError("请求体必须包含字符串类型的 text", 400);
  }
  validatePromptText(value.text);
  return { text: value.text };
}

function writeSse<EventName extends keyof SseEventMap>(
  response: ServerResponse,
  event: EventName,
  data: SseEventMap[EventName],
): void {
  if (response.destroyed || response.writableEnded) return;
  response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

interface ToolCallEventData {
  readonly id: string;
  readonly name: string;
  readonly arguments: JsonObject;
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

function messageToolCalls(message: unknown): ToolCallEventData[] {
  if (
    typeof message !== "object" || message === null || !("role" in message) ||
    message.role !== "assistant" || !("content" in message) || !Array.isArray(message.content)
  ) return [];
  const calls: ToolCallEventData[] = [];
  for (const part of message.content) {
    if (
      typeof part === "object" && part !== null && "type" in part && part.type === "toolCall" &&
      "id" in part && typeof part.id === "string" &&
      "name" in part && typeof part.name === "string"
    ) {
      calls.push({
        id: part.id,
        name: part.name,
        arguments: normalizedToolArguments("arguments" in part ? part.arguments : undefined),
      });
    }
  }
  return calls;
}

function isFinalTurnMessage(message: unknown): boolean {
  return typeof message === "object" && message !== null &&
    "role" in message && message.role === "assistant" &&
    "stopReason" in message && (message.stopReason === "stop" || message.stopReason === "length") &&
    messageToolCalls(message).length === 0;
}

function automaticCompactionReason(
  reason: "manual" | "threshold" | "overflow",
): AutomaticCompactionReason | undefined {
  return reason === "threshold" || reason === "overflow" ? reason : undefined;
}

function compactionOutcome(
  event: Extract<AgentSessionEvent, { type: "compaction_end" }>,
): CompactionOutcome {
  if (event.aborted) return "aborted";
  return event.result === undefined ? "failed" : "completed";
}

function createAgentEventStreamer(response: ServerResponse): (event: AgentSessionEvent) => void {
  let turn = -1;
  let announcedToolCalls = new Set<string>();
  const announceToolCall = (call: ToolCallEventData): void => {
    if (announcedToolCalls.has(call.id)) return;
    announcedToolCalls.add(call.id);
    writeSse(response, "tool_call", { turn, ...call });
  };

  return (event) => {
    if (event.type === "turn_start") {
      turn += 1;
      announcedToolCalls = new Set<string>();
      writeSse(response, "turn_start", { turn });
    } else if (event.type === "message_update") {
      if (event.assistantMessageEvent.type === "text_delta") {
        writeSse(response, "text_delta", { turn, delta: event.assistantMessageEvent.delta });
      } else if (event.assistantMessageEvent.type === "toolcall_end") {
        announceToolCall({
          id: event.assistantMessageEvent.toolCall.id,
          name: event.assistantMessageEvent.toolCall.name,
          arguments: normalizedToolArguments(event.assistantMessageEvent.toolCall.arguments),
        });
      }
    } else if (event.type === "message_end") {
      for (const call of messageToolCalls(event.message)) announceToolCall(call);
    } else if (event.type === "tool_execution_start") {
      writeSse(response, "tool_start", {
        turn,
        id: event.toolCallId,
        name: event.toolName,
      });
    } else if (event.type === "tool_execution_update") {
      const details = typeof event.partialResult === "object" && event.partialResult !== null &&
          "details" in event.partialResult
        ? event.partialResult.details
        : undefined;
      if (event.toolName === "update_dashboard" && isDashboardUpdateDetails(details)) {
        writeSse(response, "dashboard_update", {
          turn,
          toolCallId: event.toolCallId,
          dashboardId: details.dashboardId,
          dashboard: details.dashboard,
        });
      }
    } else if (event.type === "tool_execution_end") {
      writeSse(response, "tool_end", {
        turn,
        id: event.toolCallId,
        name: event.toolName,
        isError: event.isError,
      });
    } else if (event.type === "turn_end") {
      writeSse(response, "turn_end", {
        turn,
        final: isFinalTurnMessage(event.message),
      });
    } else if (event.type === "compaction_start") {
      const reason = automaticCompactionReason(event.reason);
      if (reason) writeSse(response, "compaction_start", { reason });
    } else if (event.type === "compaction_end") {
      const reason = automaticCompactionReason(event.reason);
      if (reason) {
        writeSse(response, "compaction_end", {
          reason,
          outcome: compactionOutcome(event),
        });
      }
    } else if (event.type === "auto_retry_start") {
      writeSse(response, "status", {
        message: `请求失败,正在进行第 ${event.attempt} 次重试…`,
      });
    }
  };
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

function errorStatus(error: unknown): number {
  if (error instanceof AuthError) return error.statusCode;
  if (error instanceof HttpError) return error.statusCode;
  if (error instanceof SessionNotFoundError) return 404;
  if (error instanceof SessionBusyError) return 409;
  if (
    error instanceof TypeError || error instanceof DatabaseInputError ||
    error instanceof DashboardInputError
  ) return 400;
  return 500;
}

async function serveStatic(
  response: ServerResponse,
  publicDir: string,
  vendorDir: string,
  pathname: string,
): Promise<boolean> {
  const target = STATIC_FILES.get(pathname);
  if (!target) return false;
  const rootDir = target.root === "public" ? publicDir : vendorDir;
  const filePath = path.join(rootDir, target.filename);
  const metadata = await stat(filePath);
  response.writeHead(200, {
    ...securityHeaders(target.contentType),
    "Content-Length": metadata.size,
  });
  createReadStream(filePath).pipe(response);
  return true;
}

function decodeSessionId(match: RegExpExecArray): string {
  const encodedId = match[1];
  if (!encodedId) throw new HttpError("会话 ID 不能为空", 400);
  try {
    return decodeURIComponent(encodedId);
  } catch {
    throw new HttpError("会话 ID 编码无效", 400);
  }
}

function requestRoute(pathname: string): string {
  if (/^\/api\/sessions\/[^/]+\/fork$/u.test(pathname)) return "/api/sessions/:id/fork";
  if (/^\/api\/sessions\/[^/]+\/messages$/u.test(pathname)) return "/api/sessions/:id/messages";
  if (/^\/api\/sessions\/[^/]+\/abort$/u.test(pathname)) return "/api/sessions/:id/abort";
  if (/^\/api\/sessions\/[^/]+$/u.test(pathname)) return "/api/sessions/:id";
  return pathname;
}

export function createWebServer({ database, sessions, publicDir, vendorDir, logger = console,
  authentication = new Authentication(), dashboardForAccount = () => ["default"] }: WebServerOptions): Server {
  return http.createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    const requestId = randomUUID();
    const apiRequest = url.pathname.startsWith("/api/") || url.pathname === "/chat/compeletion";
    const requestLogger = logger.child?.({ requestId }) ?? logger;
    const requestStartedAt = Date.now();
    let requestSettled = false;
    response.setHeader("X-Request-Id", requestId);
    if (apiRequest) {
      requestLogger.info?.("http.request.started", {
        method: request.method ?? "UNKNOWN",
        route: requestRoute(url.pathname),
        pathname: url.pathname,
      });
      const settleRequest = (aborted: boolean): void => {
        if (requestSettled) return;
        requestSettled = true;
        const fields = {
          method: request.method ?? "UNKNOWN",
          route: requestRoute(url.pathname),
          pathname: url.pathname,
          statusCode: response.statusCode,
          durationMs: Date.now() - requestStartedAt,
          aborted,
        };
        if (aborted) requestLogger.warn?.("http.request.completed", fields);
        else requestLogger.info?.("http.request.completed", fields);
      };
      response.once("finish", () => settleRequest(false));
      response.once("close", () => settleRequest(!response.writableFinished));
    }
    try {
      if (request.method === "GET" && (await serveStatic(response, publicDir, vendorDir, url.pathname))) return;

      if (url.pathname.startsWith("/api/") && !["GET", "HEAD"].includes(request.method ?? "")) authentication.requireSameOrigin(request);
      if (request.method === "POST" && url.pathname === "/api/auth/login") {
        const login = await authentication.login(await readJson(request), request.socket.remoteAddress ?? "unknown");
        // Replacing an existing browser login also revokes its previous token.
        authentication.logout(request);
        response.setHeader("Set-Cookie", login.cookie);
        json(response, 200, { account: login.account, expiresAt: login.expiresAt, dashboardIds: dashboardForAccount(login.account) });
        return;
      }
      if (request.method === "POST" && url.pathname === "/api/auth/logout") {
        await readJson(request);
        response.setHeader("Set-Cookie", authentication.logout(request));
        json(response, 200, { ok: true });
        return;
      }
      const login = url.pathname.startsWith("/api/") && url.pathname !== "/api/health" ? authentication.require(request) : undefined;
      if (request.method === "GET" && url.pathname === "/api/auth/me") {
        json(response, 200, { ...login!, dashboardIds: dashboardForAccount(login!.account) });
        return;
      }
      const accountSessions = login ? sessions.forAccount(login.account) : undefined;

      if (request.method === "POST" && url.pathname === "/chat/compeletion") {
        const controller = new AbortController();
        const onClose = (): void => {
          if (!response.writableFinished) controller.abort(new Error("客户端已断开连接"));
        };
        response.once("close", onClose);
        try {
          const body = requireChatCompletionRequest(await readJson(request));
          if (response.destroyed) controller.abort(new Error("客户端已断开连接"));
          controller.signal.throwIfAborted();
          const text = await sessions.complete(body.text, { requestId, signal: controller.signal });
          if (!response.destroyed) json(response, 200, { text } satisfies ChatCompletionResponse);
        } finally {
          response.off("close", onClose);
        }
        return;
      }

      if (request.method === "GET" && url.pathname === "/api/health") {
        const body = {
          ok: true,
          database: { engine: "SQLite", path: path.basename(database.filePath) },
          agent: sessions.status(),
        } satisfies HealthResponse;
        json(response, 200, body);
        return;
      }

      if (request.method === "GET" && url.pathname === "/api/schema") {
        const body = {
          objects: database.getSchema().map(({ sql: _sql, ...item }) => item),
        } satisfies SchemaResponse;
        json(response, 200, body);
        return;
      }

      if (request.method === "GET" && url.pathname === "/api/sessions") {
        const body = { sessions: await accountSessions!.list() } satisfies SessionsResponse;
        json(response, 200, body);
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/sessions") {
        await readJson(request);
        json(response, 201, await accountSessions!.create());
        return;
      }

      const forkMatch = /^\/api\/sessions\/([^/]+)\/fork$/u.exec(url.pathname);
      if (request.method === "POST" && forkMatch) {
        await readJson(request);
        json(response, 201, await accountSessions!.fork(decodeSessionId(forkMatch)));
        return;
      }

      const sessionMatch = /^\/api\/sessions\/([^/]+)$/u.exec(url.pathname);
      if (request.method === "GET" && sessionMatch) {
        json(response, 200, await accountSessions!.getSerialized(decodeSessionId(sessionMatch)));
        return;
      }
      if (request.method === "DELETE" && sessionMatch) {
        await accountSessions!.delete(decodeSessionId(sessionMatch));
        json(response, 200, { ok: true } satisfies DeleteSessionResponse);
        return;
      }

      const messageMatch = /^\/api\/sessions\/([^/]+)\/messages$/u.exec(url.pathname);
      if (request.method === "POST" && messageMatch) {
        const id = decodeSessionId(messageMatch);
        const body = requireMessageRequest(await readJson(request));
        const session = await accountSessions!.get(id);
        if (session.isStreaming) throw new SessionBusyError();
        const snapshot = await accountSessions!.getSerialized(id);
        if (!snapshot.dashboards.some((item) => item.id === body.dashboardId)) throw new HttpError("会话中不存在该看板", 400);

        response.writeHead(200, {
          ...securityHeaders("text/event-stream; charset=utf-8"),
          Connection: "keep-alive",
          "X-Accel-Buffering": "no",
        });
        response.flushHeaders();
        const unsubscribe = session.subscribe(createAgentEventStreamer(response));
        try {
          await accountSessions!.prompt(id, body.message, requestId, body.dashboardId);
          writeSse(response, "done", await accountSessions!.getSerialized(id));
        } catch (error) {
          requestLogger.error("http.agent_prompt.failed", error, { sessionId: id });
          writeSse(response, "error", {
            message: errorMessage(error, "Agent 回答失败"),
            requestId,
          });
        } finally {
          unsubscribe();
          response.end();
        }
        return;
      }

      const abortMatch = /^\/api\/sessions\/([^/]+)\/abort$/u.exec(url.pathname);
      if (request.method === "POST" && abortMatch) {
        await readJson(request);
        await accountSessions!.abort(decodeSessionId(abortMatch));
        json(response, 200, { ok: true } satisfies AbortResponse);
        return;
      }

      json(response, 404, { error: "接口不存在", requestId } satisfies ErrorResponse);
    } catch (error) {
      if (error instanceof AuthError && error.statusCode === 429) response.setHeader("Retry-After", "300");
      requestLogger.error("http.request.failed", error, {
        method: request.method ?? "UNKNOWN",
        pathname: url.pathname,
        statusCode: errorStatus(error),
      });
      if (response.destroyed) return;
      if (!response.headersSent) {
        json(response, errorStatus(error), {
          error: errorMessage(error, "服务器内部错误"),
          requestId,
        } satisfies ErrorResponse);
      }
      else response.end();
    }
  });
}
