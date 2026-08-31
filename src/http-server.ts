import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import http from "node:http";
import type { IncomingMessage, OutgoingHttpHeaders, Server, ServerResponse } from "node:http";
import path from "node:path";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import type {
  AgentStatus,
  MessageRequest,
  SerializedSession,
  SessionSummary,
  SseEventMap,
} from "../shared/contracts.js";
import { SessionBusyError, SessionNotFoundError } from "./agent-sessions.js";
import type { AgentSessionStore } from "./agent-sessions.js";
import { DatabaseInputError } from "./database.js";
import type { DemoDatabase } from "./database.js";

const MAX_BODY_BYTES = 64 * 1024;
const STATIC_FILES = new Map<string, readonly [filename: string, contentType: string]>([
  ["/", ["index.html", "text/html; charset=utf-8"]],
  ["/app.js", ["generated/client/app.js", "text/javascript; charset=utf-8"]],
  ["/styles.css", ["styles.css", "text/css; charset=utf-8"]],
]);

interface Logger {
  error(message: string, error: unknown): void;
}

export interface WebSessionPort {
  status(): AgentStatus;
  list(): Promise<SessionSummary[]>;
  create(): Promise<SerializedSession>;
  get(id: string): ReturnType<AgentSessionStore["get"]>;
  getSerialized(id: string): Promise<SerializedSession>;
  prompt(id: string, text: string): Promise<void>;
  abort(id: string): Promise<void>;
}

export interface WebServerOptions {
  database: DemoDatabase;
  sessions: WebSessionPort;
  publicDir: string;
  logger?: Logger;
}

class HttpError extends Error {
  constructor(message: string, readonly statusCode: number) {
    super(message);
    this.name = "HttpError";
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

function json(response: ServerResponse, status: number, value: unknown): void {
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
    return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
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

function streamAgentEvent(response: ServerResponse, event: AgentSessionEvent): void {
  if (event.type === "message_update" && event.assistantMessageEvent?.type === "text_delta") {
    writeSse(response, "text_delta", { delta: event.assistantMessageEvent.delta });
  } else if (event.type === "tool_execution_start") {
    writeSse(response, "tool_start", {
      id: event.toolCallId,
      name: event.toolName,
    });
  } else if (event.type === "tool_execution_end") {
    writeSse(response, "tool_end", {
      id: event.toolCallId,
      name: event.toolName,
      isError: event.isError,
    });
  } else if (event.type === "auto_retry_start") {
    writeSse(response, "status", {
      message: `请求失败，正在进行第 ${event.attempt} 次重试…`,
    });
  }
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

async function serveStatic(response: ServerResponse, publicDir: string, pathname: string): Promise<boolean> {
  const target = STATIC_FILES.get(pathname);
  if (!target) return false;
  const [filename, contentType] = target;
  const filePath = path.join(publicDir, filename);
  const metadata = await stat(filePath);
  response.writeHead(200, {
    ...securityHeaders(contentType),
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

export function createWebServer({ database, sessions, publicDir, logger = console }: WebServerOptions): Server {
  return http.createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    try {
      if (request.method === "GET" && (await serveStatic(response, publicDir, url.pathname))) return;

      if (request.method === "GET" && url.pathname === "/api/health") {
        json(response, 200, {
          ok: true,
          database: { engine: "SQLite", path: path.basename(database.filePath) },
          agent: sessions.status(),
        });
        return;
      }

      if (request.method === "GET" && url.pathname === "/api/schema") {
        json(response, 200, { objects: database.getSchema().map(({ sql: _sql, ...item }) => item) });
        return;
      }

      if (request.method === "GET" && url.pathname === "/api/sessions") {
        json(response, 200, { sessions: await sessions.list() });
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
        const unsubscribe = session.subscribe((event) => streamAgentEvent(response, event));
        try {
          await sessions.prompt(id, body.message);
          writeSse(response, "done", await sessions.getSerialized(id));
        } catch (error) {
          logger.error("Agent prompt failed", error);
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
        json(response, 200, { ok: true });
        return;
      }

      json(response, 404, { error: "接口不存在" });
    } catch (error) {
      logger.error("HTTP request failed", error);
      if (!response.headersSent) {
        json(response, errorStatus(error), { error: errorMessage(error, "服务器内部错误") });
      }
      else response.end();
    }
  });
}
