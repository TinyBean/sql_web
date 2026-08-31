export type ChatRole = "user" | "assistant";
export type DatabaseToolName = "query_database" | "execute_database";

export interface ChatMessage {
  readonly id: string;
  readonly role: ChatRole;
  readonly text: string;
  readonly timestamp?: number;
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
  readonly tools: readonly DatabaseToolName[];
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
  readonly tools: readonly DatabaseToolName[];
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

export interface SseEventMap {
  text_delta: { delta: string };
  tool_start: { id: string; name: string };
  tool_end: { id: string; name: string; isError: boolean };
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
  | ErrorResponse
  | HealthResponse
  | SchemaResponse
  | SerializedSession
  | SessionsResponse;
