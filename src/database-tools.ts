import { defineTool } from "@earendil-works/pi-coding-agent";
import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { AgentToolName } from "../shared/contracts.ts";
import { MAX_QUERY_ARTIFACT_BYTES } from "./artifact-store.ts";
import type { SessionArtifactStore } from "./artifact-store.ts";
import type { CodeInterpreterRuntime } from "./code-interpreter.ts";
import type { AppDatabase } from "./database.ts";
import type { QueryResult, QueryTruncationReason } from "./database.ts";

export const BASE_AGENT_TOOL_NAMES = ["execute_sql", "get_current_time"] as const satisfies
  readonly AgentToolName[];
export const ALL_AGENT_TOOL_NAMES = [...BASE_AGENT_TOOL_NAMES, "code_interpreter"] as const satisfies
  readonly AgentToolName[];

const INLINE_MAX_ROWS = 200;
const FILE_MAX_ROWS = 100_000;

interface SqlFileResult {
  readonly outputFormat: "json_file";
  readonly fileUri: string;
  readonly rowCount: number;
  readonly byteCount: number;
  readonly truncated: boolean;
  readonly truncationReason: QueryTruncationReason | null;
}

type ExecuteSqlDetails = QueryResult | SqlFileResult;

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

export function activeAgentToolNames(codeInterpreter: CodeInterpreterRuntime): AgentToolName[] {
  return codeInterpreter.status.available ? [...ALL_AGENT_TOOL_NAMES] : [...BASE_AGENT_TOOL_NAMES];
}

export function createAgentTools(
  database: AppDatabase,
  artifacts: SessionArtifactStore,
  codeInterpreter: CodeInterpreterRuntime,
) {
  const executeSqlTool = defineTool({
    name: "execute_sql",
    label: "执行只读 SQL",
    description:
      "Execute exactly one read-only SQLite query. output_format=inline returns up to 200 rows. output_format=json_file streams up to 100,000 rows or 32 MiB into a session-scoped JSON artifact and returns its artifact:// URI for code_interpreter. Writes, DDL, and state-changing PRAGMAs are rejected.",
    promptSnippet: "执行只读 SQLite 查询，可返回少量结果或生成供代码解释器读取的 JSON 文件",
    executionMode: "sequential",
    parameters: Type.Object({
      sql: Type.String({ description: "A single read-only SQLite SELECT, WITH, PRAGMA, or EXPLAIN query." }),
      parameters: sqlParameters,
      output_format: Type.Optional(
        Type.Union([Type.Literal("inline"), Type.Literal("json_file")], {
          description: "inline (default) returns rows directly; json_file returns a session-scoped artifact URI.",
        }),
      ),
      limit: Type.Optional(
        Type.Integer({
          description: "Row limit. inline: 1-200, default 200. json_file: 1-100000, default 100000.",
          minimum: 1,
          maximum: FILE_MAX_ROWS,
        }),
      ),
    }),
    async execute(_toolCallId, params, signal): Promise<AgentToolResult<ExecuteSqlDetails>> {
      signal?.throwIfAborted();
      if ((params.output_format ?? "inline") === "inline") {
        if (params.limit !== undefined && params.limit > INLINE_MAX_ROWS) {
          throw new TypeError(`inline 模式的 limit 不能超过 ${INLINE_MAX_ROWS}`);
        }
        const options = { maxRows: params.limit ?? INLINE_MAX_ROWS };
        const result = database.query(params.sql, params.parameters, options);
        signal?.throwIfAborted();
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
          details: result,
        };
      }

      const maxRows = params.limit ?? FILE_MAX_ROWS;
      const created = artifacts.createJson((fileDescriptor) => database.exportQueryJson(
        params.sql,
        params.parameters,
        {
          fileDescriptor,
          maxRows,
          maxBytes: MAX_QUERY_ARTIFACT_BYTES,
          ...(signal === undefined ? {} : { signal }),
        },
      ));
      signal?.throwIfAborted();
      const result = {
        outputFormat: "json_file" as const,
        fileUri: created.fileUri,
        rowCount: created.value.rowCount,
        byteCount: created.byteCount,
        truncated: created.value.truncated,
        truncationReason: created.value.truncationReason,
      };
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
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

  if (!codeInterpreter.status.available) return [executeSqlTool, currentTimeTool];
  const codeInterpreterTool = defineTool({
    name: "code_interpreter",
    label: "执行受限 Python",
    description:
      "Run Python in a strict, network-disabled sandbox for exact calculations, statistics, or PNG rendering. input_json may be inline JSON or an artifact:// URI returned by execute_sql; it is available in Python as input_data. Use print() for text and emit_image() for Matplotlib Figure or Pillow Image output. Matplotlib is preconfigured with a Simplified Chinese system font: do not replace it with hard-coded font families such as SimHei. When explicit Matplotlib font properties are needed, use matplotlib_chinese_font(size), or matplotlib_chinese_font(size, bold=True) for bold text. For Chinese Pillow text, use chinese_font(size), or chinese_font(size, bold=True) for bold text. Emitted PNGs are attached to the answer automatically; never invent a Markdown image URL. The sandbox cannot access SQLite, project files, arbitrary host paths, or install packages.",
    promptSnippet: "在严格沙箱中执行 Python，进行额外计算、统计或 PNG 图表渲染",
    executionMode: "sequential",
    parameters: Type.Object({
      code: Type.String({ description: "Python source code to execute.", maxLength: 20_000 }),
      input_json: Type.Optional(
        Type.String({
          description: "Inline JSON text or an artifact:// URI from execute_sql. Parsed as the input_data global.",
        }),
      ),
    }),
    async execute(_toolCallId, params, signal) {
      const result = await codeInterpreter.execute(params.code, params.input_json, artifacts, signal);
      return {
        content: [{ type: "text" as const, text: result.text }],
        details: result.details,
      };
    },
  });

  return [executeSqlTool, currentTimeTool, codeInterpreterTool];
}
