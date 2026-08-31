export type ChatRole = "user" | "assistant";

export interface ChatMessage {
  id: string;
  role: ChatRole;
  text: string;
  timestamp?: number;
}

export interface ModelDescriptor {
  provider: string;
  id: string;
  name: string;
}

export interface SerializedSession {
  id: string;
  title: string;
  model: ModelDescriptor | null;
  tools: string[];
  streaming: boolean;
  messages: ChatMessage[];
}

export interface SessionSummary {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
  active: boolean;
}

export interface ModelSelection {
  provider: string | null;
  model: string | null;
}

export interface AgentStatus {
  tools: string[];
  model: ModelSelection;
  availableModelCount: number;
  activeSessionCount: number;
}

export interface HealthResponse {
  ok: true;
  database: { engine: "SQLite"; path: string };
  agent: AgentStatus;
}

export interface SchemaColumn {
  name: string;
  type: string;
  nullable: boolean;
  primaryKey: boolean;
}

export interface SchemaObject {
  type: "table" | "view";
  name: string;
  sql: string | null;
  columns: SchemaColumn[];
}

export type PublicSchemaObject = Omit<SchemaObject, "sql">;

export interface SchemaResponse {
  objects: PublicSchemaObject[];
}

export interface SessionsResponse {
  sessions: SessionSummary[];
}

export interface MessageRequest {
  message: string;
}

export interface ErrorResponse {
  error: string;
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
