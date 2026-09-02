import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { AgentToolName } from "../shared/contracts.ts";
import type { AppDatabase } from "./database.ts";

export const AGENT_TOOL_NAMES = ["execute_sql", "get_current_time"] as const satisfies
  readonly AgentToolName[];

const scalar = Type.Union([Type.String(), Type.Number(), Type.Boolean(), Type.Null()]);
const sqlParameters = Type.Optional(
  Type.Array(scalar, {
    description: "Values for positional ? placeholders, in order.",
    maxItems: 100,
  }),
);

export interface CurrentTimeResult {
  readonly utc: string;
  readonly local: string;
  readonly timezone: string;
}

export function getCurrentTime(now = new Date()): CurrentTimeResult {
  return {
    utc: now.toISOString(),
    local: now.toLocaleString("zh-CN", { hour12: false, timeZoneName: "longOffset" }),
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  };
}

export function createAgentTools(database: AppDatabase) {
  const executeSqlTool = defineTool({
    name: "execute_sql",
    label: "执行只读 SQL",
    description:
      "Execute exactly one read-only SQLite SQL statement and return its columns and rows. This tool cannot insert, update, or delete data. Use ? placeholders with the optional parameters array. Results are capped at 200 rows.",
    promptSnippet: "执行一条只读 SQLite 查询并返回结构化结果",
    executionMode: "sequential",
    parameters: Type.Object({
      sql: Type.String({ description: "A single read-only SQLite SELECT, WITH, PRAGMA, or EXPLAIN query." }),
      parameters: sqlParameters,
      limit: Type.Optional(
        Type.Integer({ description: "Maximum rows to return (1-200, default 100).", minimum: 1, maximum: 200 }),
      ),
    }),
    async execute(_toolCallId, params, signal) {
      signal?.throwIfAborted();
      const options = params.limit === undefined ? {} : { maxRows: params.limit };
      const result = database.query(params.sql, params.parameters, options);
      signal?.throwIfAborted();
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        details: result,
      };
    },
  });

  const currentTimeTool = defineTool({
    name: "get_current_time",
    label: "查询当前时间",
    description: "Return the server's current time, including UTC and local timezone representations.",
    promptSnippet: "查询当前日期和时间",
    executionMode: "sequential",
    parameters: Type.Object({}),
    async execute(_toolCallId, _params, signal) {
      signal?.throwIfAborted();
      const result = getCurrentTime();
      signal?.throwIfAborted();
      return {
        content: [{ type: "text", text: JSON.stringify(result) }],
        details: result,
      };
    },
  });

  return [executeSqlTool, currentTimeTool];
}
