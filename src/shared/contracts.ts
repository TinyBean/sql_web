import type { DashboardState } from "./dashboard.ts";

export type ChatRole = "user" | "assistant";
export type AgentToolName = string;

export type JsonValue = string | number | boolean | null | readonly JsonValue[] | JsonObject;

export interface JsonObject {
  readonly [key: string]: JsonValue;
}

export const AGENT_TOOL_NAME_PATTERN = /^[a-z][a-z0-9_]{0,63}$/u;

export function isAgentToolName(value: unknown): value is AgentToolName {
  return typeof value === "string" && AGENT_TOOL_NAME_PATTERN.test(value);
}

export interface ChatImage {
  readonly id: string;
  readonly mimeType: "image/png";
  readonly data: string;
  readonly alt: string;
}

export interface ChatTraceText {
  readonly type: "text";
  readonly text: string;
}

export interface ChatTraceTool {
  readonly type: "tool";
  readonly id: string;
  readonly name: string;
  readonly arguments: JsonObject;
  readonly isError: boolean;
}

export type ChatTraceItem = ChatTraceText | ChatTraceTool;

export interface ChatMessage {
  readonly id: string;
  readonly role: ChatRole;
  readonly text: string;
  readonly timestamp?: number;
  readonly trace?: readonly ChatTraceItem[];
  readonly images?: readonly ChatImage[];
}

export interface ModelDescriptor {
  readonly provider: string;
  readonly id: string;
  readonly name: string;
}

export interface SerializedSession {
  readonly id: string;
  readonly title: string;
  readonly model: ModelDescriptor | null;
  readonly tools: readonly AgentToolName[];
  readonly streaming: boolean;
  readonly dashboard: DashboardState;
  readonly messages: readonly ChatMessage[];
}

export interface SessionSummary {
  readonly id: string;
  readonly title: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly messageCount: number;
  readonly active: boolean;
}

export interface ModelSelection {
  readonly provider: string;
  readonly model: string;
}

export interface AgentStatus {
  readonly tools: readonly AgentToolName[];
  readonly codeInterpreter: { readonly available: boolean; readonly reason: string | null };
  readonly model: ModelSelection;
  readonly availableModelCount: number;
  readonly activeSessionCount: number;
}

export interface HealthResponse {
  readonly ok: true;
  readonly database: { readonly engine: "SQLite"; readonly path: string };
  readonly agent: AgentStatus;
}

export interface SchemaColumn {
  readonly name: string;
  readonly type: string;
  readonly nullable: boolean;
  readonly primaryKey: boolean;
}

export interface SchemaObject {
  readonly type: "table" | "view";
  readonly name: string;
  readonly sql: string | null;
  readonly columns: readonly SchemaColumn[];
}

export type PublicSchemaObject = Omit<SchemaObject, "sql">;

export interface SchemaResponse {
  readonly objects: readonly PublicSchemaObject[];
}

export interface SessionsResponse {
  readonly sessions: readonly SessionSummary[];
}

export interface MessageRequest {
  readonly message: string;
}

export interface ErrorResponse {
  readonly error: string;
  readonly requestId: string;
}

export interface AbortResponse {
  readonly ok: true;
}

export interface DeleteSessionResponse {
  readonly ok: true;
}

export type AutomaticCompactionReason = "threshold" | "overflow";
export type CompactionOutcome = "completed" | "aborted" | "failed";

export interface SseEventMap {
  turn_start: { turn: number };
  text_delta: { turn: number; delta: string };
  tool_call: { turn: number; id: string; name: string; arguments: JsonObject };
  tool_start: { turn: number; id: string; name: string };
  tool_end: { turn: number; id: string; name: string; isError: boolean };
  generated_image: { turn: number; toolCallId: string; image: ChatImage };
  dashboard_update: { turn: number; toolCallId: string; dashboard: DashboardState };
  turn_end: { turn: number; final: boolean };
  compaction_start: { reason: AutomaticCompactionReason };
  compaction_end: { reason: AutomaticCompactionReason; outcome: CompactionOutcome };
  status: { message: string };
  error: { message: string; requestId?: string };
  done: SerializedSession;
}

export type ParsedSseEvent = {
  [EventName in keyof SseEventMap]: {
    event: EventName;
    data: SseEventMap[EventName];
  };
}[keyof SseEventMap];

export type JsonResponseBody =
  | AbortResponse
  | DeleteSessionResponse
  | ErrorResponse
  | HealthResponse
  | SchemaResponse
  | SerializedSession
  | SessionsResponse;
