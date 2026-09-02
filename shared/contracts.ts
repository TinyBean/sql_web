export type ChatRole = "user" | "assistant";
export type AgentToolName = "execute_sql" | "get_current_time" | "code_interpreter";

export interface ChatImage {
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
}

export interface AbortResponse {
  readonly ok: true;
}

export interface DeleteSessionResponse {
  readonly ok: true;
}

export interface SseEventMap {
  turn_start: { turn: number };
  text_delta: { turn: number; delta: string };
  tool_call: { turn: number; id: string; name: string };
  tool_start: { turn: number; id: string; name: string };
  tool_end: { turn: number; id: string; name: string; isError: boolean };
  turn_end: { turn: number; final: boolean };
  status: { message: string };
  error: { message: string };
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
