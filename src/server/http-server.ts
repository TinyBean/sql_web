import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import http from "node:http";
import type { IncomingMessage, OutgoingHttpHeaders, Server, ServerResponse } from "node:http";
import path from "node:path";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import type {
  AbortResponse,
  AgentStatus,
  DeleteSessionResponse,
  ErrorResponse,
  HealthResponse,
  JsonResponseBody,
  MessageRequest,
  SchemaResponse,
  SerializedSession,
  SessionSummary,
  SessionsResponse,
  SseEventMap,
} from "../shared/contracts.ts";
import { SessionBusyError, SessionNotFoundError } from "./agent/agent-sessions.ts";
import { DatabaseInputError } from "./data/database.ts";
import type { AppDatabase } from "./data/database.ts";

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
  ["/image-placeholders.js", { root: "public", filename: "generated/client/image-placeholders.js", contentType: "text/javascript; charset=utf-8" }],
  ["/markdown.js", { root: "public", filename: "generated/client/markdown.js", contentType: "text/javascript; charset=utf-8" }],
  ["/stream-state.js", { root: "public", filename: "generated/client/stream-state.js", contentType: "text/javascript; charset=utf-8" }],
  ["/styles.css", { root: "public", filename: "styles.css", contentType: "text/css; charset=utf-8" }],
  ["/vendor/marked.js", { root: "vendor", filename: "marked/lib/marked.umd.js", contentType: "text/javascript; charset=utf-8" }],
  ["/vendor/dompurify.js", { root: "vendor", filename: "dompurify/dist/purify.min.js", contentType: "text/javascript; charset=utf-8" }],
]);

interface Logger {
  error(
    event: string,
    error: unknown,
    fields?: Readonly<Record<string, unknown>>,
  ): void;
}

export interface WebSessionPort {
  status(): AgentStatus;
  list(): Promise<SessionSummary[]>;
  create(): Promise<SerializedSession>;
  get(id: string): Promise<StreamableAgentSession>;
  getSerialized(id: string): Promise<SerializedSession>;
  delete(id: string): Promise<void>;
  prompt(id: string, text: string): Promise<void>;
  abort(id: string): Promise<void>;
}

export interface StreamableAgentSession {
  readonly isStreaming: boolean;
  subscribe(listener: (event: AgentSessionEvent) => void): () => void;
}

export interface WebServerOptions {
  database: AppDatabase;
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
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) {
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
  return { message: value.message };
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
    ) calls.push({ id: part.id, name: part.name });
  }
  return calls;
}

function isFinalTurnMessage(message: unknown): boolean {
  return typeof message === "object" && message !== null &&
    "role" in message && message.role === "assistant" &&
    "stopReason" in message && (message.stopReason === "stop" || message.stopReason === "length") &&
    messageToolCalls(message).length === 0;
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
  if (error instanceof HttpError) return error.statusCode;
  if (error instanceof SessionNotFoundError) return 404;
  if (error instanceof SessionBusyError) return 409;
  if (error instanceof TypeError || error instanceof DatabaseInputError) return 400;
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

export function createWebServer({ database, sessions, publicDir, vendorDir, logger = console }: WebServerOptions): Server {
  return http.createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    try {
      if (request.method === "GET" && (await serveStatic(response, publicDir, vendorDir, url.pathname))) return;

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
        const body = { sessions: await sessions.list() } satisfies SessionsResponse;
        json(response, 200, body);
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/sessions") {
        await readJson(request);
        json(response, 201, await sessions.create());
        return;
      }

      const sessionMatch = /^\/api\/sessions\/([^/]+)$/u.exec(url.pathname);
      if (request.method === "GET" && sessionMatch) {
        json(response, 200, await sessions.getSerialized(decodeSessionId(sessionMatch)));
        return;
      }
      if (request.method === "DELETE" && sessionMatch) {
        await sessions.delete(decodeSessionId(sessionMatch));
        json(response, 200, { ok: true } satisfies DeleteSessionResponse);
        return;
      }

      const messageMatch = /^\/api\/sessions\/([^/]+)\/messages$/u.exec(url.pathname);
      if (request.method === "POST" && messageMatch) {
        const id = decodeSessionId(messageMatch);
        const body = requireMessageRequest(await readJson(request));
        const session = await sessions.get(id);
        if (session.isStreaming) throw new SessionBusyError();

        response.writeHead(200, {
          ...securityHeaders("text/event-stream; charset=utf-8"),
          Connection: "keep-alive",
          "X-Accel-Buffering": "no",
        });
        response.flushHeaders();
        const unsubscribe = session.subscribe(createAgentEventStreamer(response));
        try {
          await sessions.prompt(id, body.message);
          writeSse(response, "done", await sessions.getSerialized(id));
        } catch (error) {
          logger.error("http.agent_prompt.failed", error, { sessionId: id });
          writeSse(response, "error", { message: errorMessage(error, "Agent 回答失败") });
        } finally {
          unsubscribe();
          response.end();
        }
        return;
      }

      const abortMatch = /^\/api\/sessions\/([^/]+)\/abort$/u.exec(url.pathname);
      if (request.method === "POST" && abortMatch) {
        await readJson(request);
        await sessions.abort(decodeSessionId(abortMatch));
        json(response, 200, { ok: true } satisfies AbortResponse);
        return;
      }

      json(response, 404, { error: "接口不存在" } satisfies ErrorResponse);
    } catch (error) {
      logger.error("http.request.failed", error, {
        method: request.method ?? "UNKNOWN",
        pathname: url.pathname,
        statusCode: errorStatus(error),
      });
      if (!response.headersSent) {
        json(response, errorStatus(error), {
          error: errorMessage(error, "服务器内部错误"),
        } satisfies ErrorResponse);
      }
      else response.end();
    }
  });
}
