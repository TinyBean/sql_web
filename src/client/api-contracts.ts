import type {
  AbortResponse,
  ChatImage,
  ChatMessage,
  ChatRole,
  ChatTraceItem,
  AgentToolName,
  DeleteSessionResponse,
  ErrorResponse,
  HealthResponse,
  ModelDescriptor,
  ModelSelection,
  ParsedSseEvent,
  PublicSchemaObject,
  SchemaColumn,
  SchemaResponse,
  SerializedSession,
  SessionSummary,
  SessionsResponse,
} from "../shared/contracts.ts";

export type Decoder<Value> = (value: unknown, path?: string) => Value;

export class ContractValidationError extends Error {
  readonly path: string;

  constructor(path: string, expected: string) {
    super(`${path} 应为${expected}`);
    this.name = "ContractValidationError";
    this.path = path;
  }
}

function invalid(path: string, expected: string): never {
  throw new ContractValidationError(path, expected);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function record(value: unknown, path: string): Record<string, unknown> {
  return isRecord(value) ? value : invalid(path, "对象");
}

function string(value: unknown, path: string): string {
  return typeof value === "string" ? value : invalid(path, "字符串");
}

function boolean(value: unknown, path: string): boolean {
  return typeof value === "boolean" ? value : invalid(path, "布尔值");
}

function nonNegativeInteger(value: unknown, path: string): number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0
    ? value
    : invalid(path, "非负整数");
}

function array<Value>(
  value: unknown,
  path: string,
  decode: (item: unknown, itemPath: string) => Value,
): Value[] {
  if (!Array.isArray(value)) return invalid(path, "数组");
  return value.map((item, index) => decode(item, `${path}[${index}]`));
}

function chatRole(value: unknown, path: string): ChatRole {
  return value === "user" || value === "assistant" ? value : invalid(path, "聊天角色");
}

function chatTraceItem(value: unknown, path: string): ChatTraceItem {
  const item = record(value, path);
  if (item["type"] === "text") {
    return {
      type: "text",
      text: string(item["text"], `${path}.text`),
    };
  }
  if (item["type"] === "tool") {
    return {
      type: "tool",
      id: string(item["id"], `${path}.id`),
      name: string(item["name"], `${path}.name`),
      isError: boolean(item["isError"], `${path}.isError`),
    };
  }
  return invalid(`${path}.type`, "text 或 tool");
}

function agentToolName(value: unknown, path: string): AgentToolName {
  return value === "execute_sql" || value === "get_current_time" || value === "code_interpreter"
    ? value
    : invalid(path, "Agent 工具名");
}

function chatImage(value: unknown, path: string): ChatImage {
  const item = record(value, path);
  if (item["mimeType"] !== "image/png") invalid(`${path}.mimeType`, "image/png");
  return {
    mimeType: "image/png",
    data: string(item["data"], `${path}.data`),
    alt: string(item["alt"], `${path}.alt`),
  };
}

function schemaObjectType(value: unknown, path: string): "table" | "view" {
  return value === "table" || value === "view" ? value : invalid(path, "table 或 view");
}

function chatMessage(value: unknown, path: string): ChatMessage {
  const item = record(value, path);
  const timestamp = item["timestamp"];
  const trace = item["trace"];
  const images = item["images"];
  return {
    id: string(item["id"], `${path}.id`),
    role: chatRole(item["role"], `${path}.role`),
    text: string(item["text"], `${path}.text`),
    ...(timestamp === undefined
      ? {}
      : { timestamp: nonNegativeInteger(timestamp, `${path}.timestamp`) }),
    ...(trace === undefined
      ? {}
      : { trace: array(trace, `${path}.trace`, chatTraceItem) }),
    ...(images === undefined
      ? {}
      : { images: array(images, `${path}.images`, chatImage) }),
  };
}

function modelDescriptor(value: unknown, path: string): ModelDescriptor {
  const item = record(value, path);
  return {
    provider: string(item["provider"], `${path}.provider`),
    id: string(item["id"], `${path}.id`),
    name: string(item["name"], `${path}.name`),
  };
}

function modelSelection(value: unknown, path: string): ModelSelection {
  const item = record(value, path);
  return {
    provider: string(item["provider"], `${path}.provider`),
    model: string(item["model"], `${path}.model`),
  };
}

function schemaColumn(value: unknown, path: string): SchemaColumn {
  const item = record(value, path);
  return {
    name: string(item["name"], `${path}.name`),
    type: string(item["type"], `${path}.type`),
    nullable: boolean(item["nullable"], `${path}.nullable`),
    primaryKey: boolean(item["primaryKey"], `${path}.primaryKey`),
  };
}

function publicSchemaObject(value: unknown, path: string): PublicSchemaObject {
  const item = record(value, path);
  if ("sql" in item) invalid(`${path}.sql`, "不存在（公开响应不得包含建表 SQL）");
  return {
    type: schemaObjectType(item["type"], `${path}.type`),
    name: string(item["name"], `${path}.name`),
    columns: array(item["columns"], `${path}.columns`, schemaColumn),
  };
}

function sessionSummary(value: unknown, path: string): SessionSummary {
  const item = record(value, path);
  return {
    id: string(item["id"], `${path}.id`),
    title: string(item["title"], `${path}.title`),
    createdAt: string(item["createdAt"], `${path}.createdAt`),
    updatedAt: string(item["updatedAt"], `${path}.updatedAt`),
    messageCount: nonNegativeInteger(item["messageCount"], `${path}.messageCount`),
    active: boolean(item["active"], `${path}.active`),
  };
}

export const decodeSerializedSession: Decoder<SerializedSession> = (value, path = "$session") => {
  const item = record(value, path);
  const model = item["model"];
  return {
    id: string(item["id"], `${path}.id`),
    title: string(item["title"], `${path}.title`),
    model: model === null ? null : modelDescriptor(model, `${path}.model`),
    tools: array(item["tools"], `${path}.tools`, agentToolName),
    streaming: boolean(item["streaming"], `${path}.streaming`),
    messages: array(item["messages"], `${path}.messages`, chatMessage),
  };
};

export const decodeSessionsResponse: Decoder<SessionsResponse> = (value, path = "$sessions") => {
  const item = record(value, path);
  return { sessions: array(item["sessions"], `${path}.sessions`, sessionSummary) };
};

export const decodeSchemaResponse: Decoder<SchemaResponse> = (value, path = "$schema") => {
  const item = record(value, path);
  return { objects: array(item["objects"], `${path}.objects`, publicSchemaObject) };
};

export const decodeHealthResponse: Decoder<HealthResponse> = (value, path = "$health") => {
  const item = record(value, path);
  if (item["ok"] !== true) invalid(`${path}.ok`, "true");
  const database = record(item["database"], `${path}.database`);
  if (database["engine"] !== "SQLite") invalid(`${path}.database.engine`, "SQLite");
  const agent = record(item["agent"], `${path}.agent`);
  const codeInterpreter = record(agent["codeInterpreter"], `${path}.agent.codeInterpreter`);
  const codeInterpreterReason = codeInterpreter["reason"];
  return {
    ok: true,
    database: {
      engine: "SQLite",
      path: string(database["path"], `${path}.database.path`),
    },
    agent: {
      tools: array(agent["tools"], `${path}.agent.tools`, agentToolName),
      codeInterpreter: {
        available: boolean(
          codeInterpreter["available"],
          `${path}.agent.codeInterpreter.available`,
        ),
        reason: codeInterpreterReason === null
          ? null
          : string(codeInterpreterReason, `${path}.agent.codeInterpreter.reason`),
      },
      model: modelSelection(agent["model"], `${path}.agent.model`),
      availableModelCount: nonNegativeInteger(
        agent["availableModelCount"],
        `${path}.agent.availableModelCount`,
      ),
      activeSessionCount: nonNegativeInteger(
        agent["activeSessionCount"],
        `${path}.agent.activeSessionCount`,
      ),
    },
  };
};

export const decodeAbortResponse: Decoder<AbortResponse> = (value, path = "$abort") => {
  const item = record(value, path);
  if (item["ok"] !== true) invalid(`${path}.ok`, "true");
  return { ok: true };
};

export const decodeDeleteSessionResponse: Decoder<DeleteSessionResponse> = (
  value,
  path = "$deleteSession",
) => {
  const item = record(value, path);
  if (item["ok"] !== true) invalid(`${path}.ok`, "true");
  return { ok: true };
};

export const decodeErrorResponse: Decoder<ErrorResponse> = (value, path = "$error") => {
  const item = record(value, path);
  return { error: string(item["error"], `${path}.error`) };
};

export function errorMessageFromResponse(value: unknown): string | undefined {
  try {
    return decodeErrorResponse(value).error;
  } catch (error) {
    if (error instanceof ContractValidationError) return undefined;
    throw error;
  }
}

export function decodeSseEvent(event: string, value: unknown): ParsedSseEvent | null {
  const path = `$sse.${event}`;
  const data = record(value, path);
  if (event === "turn_start") {
    return { event, data: { turn: nonNegativeInteger(data["turn"], `${path}.turn`) } };
  }
  if (event === "text_delta") {
    return {
      event,
      data: {
        turn: nonNegativeInteger(data["turn"], `${path}.turn`),
        delta: string(data["delta"], `${path}.delta`),
      },
    };
  }
  if (event === "tool_call" || event === "tool_start") {
    return {
      event,
      data: {
        turn: nonNegativeInteger(data["turn"], `${path}.turn`),
        id: string(data["id"], `${path}.id`),
        name: string(data["name"], `${path}.name`),
      },
    };
  }
  if (event === "tool_end") {
    return {
      event,
      data: {
        turn: nonNegativeInteger(data["turn"], `${path}.turn`),
        id: string(data["id"], `${path}.id`),
        name: string(data["name"], `${path}.name`),
        isError: boolean(data["isError"], `${path}.isError`),
      },
    };
  }
  if (event === "turn_end") {
    return {
      event,
      data: {
        turn: nonNegativeInteger(data["turn"], `${path}.turn`),
        final: boolean(data["final"], `${path}.final`),
      },
    };
  }
  if (event === "status" || event === "error") {
    return { event, data: { message: string(data["message"], `${path}.message`) } };
  }
  if (event === "done") return { event, data: decodeSerializedSession(data, path) };
  return null;
}

export function parseJson(text: string, path = "$json"): unknown {
  try {
    const value: unknown = JSON.parse(text);
    return value;
  } catch (error) {
    throw new ContractValidationError(path, "有效 JSON");
  }
}
