import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { DatabaseToolName } from "../shared/contracts.ts";
import type { DemoDatabase } from "./database.ts";

export const DATABASE_TOOL_NAMES = ["query_database", "execute_database"] as const satisfies
  readonly DatabaseToolName[];

const scalar = Type.Union([Type.String(), Type.Number(), Type.Boolean(), Type.Null()]);
const sqlParameters = Type.Optional(
  Type.Array(scalar, {
    description: "Values for positional ? placeholders, in order.",
    maxItems: 100,
  }),
);

export function createDatabaseTools(database: DemoDatabase) {
  const queryTool = defineTool({
    name: "query_database",
    label: "查询数据库",
    description:
      "Run exactly one read-only SQLite query and return columns and rows. Use ? placeholders with the optional parameters array. Results are capped at 200 rows.",
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

  const executeTool = defineTool({
    name: "execute_database",
    label: "修改数据库",
    description:
      "Run exactly one SQLite INSERT, UPDATE, DELETE, or REPLACE statement. Only use this when the user explicitly asks to change data. Use ? placeholders with the optional parameters array.",
    promptSnippet: "执行一条受控的数据写入语句",
    executionMode: "sequential",
    parameters: Type.Object({
      sql: Type.String({ description: "A single INSERT, UPDATE, DELETE, or REPLACE statement." }),
      parameters: sqlParameters,
    }),
    async execute(_toolCallId, params, signal) {
      signal?.throwIfAborted();
      const result = database.execute(params.sql, params.parameters);
      signal?.throwIfAborted();
      return {
        content: [{ type: "text", text: JSON.stringify(result) }],
        details: result,
      };
    },
  });

  return [queryTool, executeTool];
}
