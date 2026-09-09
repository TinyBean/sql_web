import { defineTool } from "@earendil-works/pi-coding-agent";
import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { AgentToolName, JsonObject } from "../../shared/contracts.ts";
import {
  generatedImageMarkdown,
  isGeneratedImageReferenceName,
  reserveSemanticGeneratedImageId,
} from "../../shared/image-references.ts";
import { MAX_QUERY_ARTIFACT_BYTES } from "./artifact-store.ts";
import type { SessionArtifactStore } from "./artifact-store.ts";
import {
  CodeInterpreterError,
  formatCodeInterpreterResult,
  type CodeInterpreterRuntime,
} from "./code-interpreter.ts";
import type { AppDatabase } from "../database/database.ts";
import type { QueryResult } from "../database/database.ts";

export const BASE_AGENT_TOOL_NAMES = ["execute_sql", "get_current_time"] as const satisfies
  readonly AgentToolName[];
export const ALL_AGENT_TOOL_NAMES = [...BASE_AGENT_TOOL_NAMES, "code_interpreter"] as const satisfies
  readonly AgentToolName[];

const INLINE_MAX_ROWS = 200;
const FILE_MAX_ROWS = 100_000;
const SNAPSHOT_PREVIEW_ROWS = 20;

interface SnapshotQueryDetails {
  readonly mode: "snapshot";
  readonly snapshot: {
    readonly name: string;
    readonly version: string;
    readonly columns: readonly string[];
    readonly rowCount: number;
    readonly byteCount: number;
    readonly createdAt: string;
    readonly truncated: false;
    readonly replaced: boolean;
  };
  readonly preview: {
    readonly rows: readonly Record<string, string | number | null>[];
    readonly rowCount: number;
    readonly truncated: boolean;
  };
  readonly pythonInput: {
    readonly rows: "snapshot_rows";
    readonly rowShape: "list[dict]";
    readonly rowAccess: "row['column_name']";
  };
}

type ExecuteSqlDetails = QueryResult | SnapshotQueryDetails;

const scalar = Type.Union([Type.String(), Type.Number(), Type.Boolean(), Type.Null()]);
const sqlParameters = Type.Optional(
  Type.Array(scalar, {
    description: "Values for positional ? placeholders, in order.",
    maxItems: 100,
  }),
);

function normalizedUserInput(value: unknown): JsonObject | null {
  if (value === undefined) return null;
  const serialized = JSON.stringify(value);
  if (serialized === undefined) throw new TypeError("user_input 必须是 JSON 对象");
  const parsed: unknown = JSON.parse(serialized);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new TypeError("user_input 必须是 JSON 对象");
  }
  return parsed as JsonObject;
}

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
  usedGeneratedImageIds: Set<string> = new Set<string>(),
) {
  const executeSqlTool = defineTool({
    name: "execute_sql",
    label: "执行只读 SQL",
    description:
      "Execute exactly one read-only SQLite query. Without save_as, return up to 200 rows inline. With save_as, atomically store the complete result as a session-scoped data snapshot (up to 100,000 rows or 32 MiB) and return its normalized logical name, metadata, up to 20 preview rows, and the exact Python row contract. Reusing a name replaces it only after the new query completes successfully. Pass the returned logical name to code_interpreter.snapshot; never copy preview rows into Python code. Snapshot rows are already objects, not positional arrays. Writes, DDL, and state-changing PRAGMAs are rejected.",
    promptSnippet: "执行只读 SQLite 查询;可用 save_as 保存会话级数据快照供后续计算",
    executionMode: "sequential",
    parameters: Type.Object({
      sql: Type.String({ description: "A single read-only SQLite SELECT, WITH, PRAGMA, or EXPLAIN query." }),
      parameters: sqlParameters,
      limit: Type.Optional(
        Type.Integer({
          description:
            "Inline row limit from 1 to 200. With save_as, only controls preview rows and is capped at 20; the snapshot still contains the complete result.",
          minimum: 1,
          maximum: INLINE_MAX_ROWS,
        }),
      ),
      save_as: Type.Optional(Type.String({
        description:
          "Short meaningful logical snapshot name. The server normalizes Chinese or English text, digits, spaces, underscores, and hyphens and returns the canonical name.",
        minLength: 1,
        maxLength: 64,
      })),
    }),
    async execute(_toolCallId, params, signal): Promise<AgentToolResult<ExecuteSqlDetails>> {
      signal?.throwIfAborted();
      if ("output_format" in (params as object)) {
        throw new TypeError("execute_sql 已移除 output_format;需要后续计算时请使用 save_as 保存数据快照");
      }
      if (params.limit !== undefined && params.limit > INLINE_MAX_ROWS) {
        throw new TypeError(`execute_sql.limit 不能超过 ${INLINE_MAX_ROWS}`);
      }
      if (params.save_as !== undefined) {
        const previewRows = Math.min(params.limit ?? SNAPSHOT_PREVIEW_ROWS, SNAPSHOT_PREVIEW_ROWS);
        const created = artifacts.createDataSnapshot(params.save_as, (fileDescriptor) => {
          const exported = database.exportQueryJson(
            params.sql,
            params.parameters,
            {
              fileDescriptor,
              maxRows: FILE_MAX_ROWS,
              maxBytes: MAX_QUERY_ARTIFACT_BYTES,
              previewRows,
              ...(signal === undefined ? {} : { signal }),
            },
          );
          if (exported.truncated) {
            const limit = exported.truncationReason === "row_limit" ? "行数" : "字节数";
            throw new CodeInterpreterError(
              `数据库查询结果因${limit}上限被截断;数据快照未保存,请先聚合、过滤或分批查询后重试`,
            );
          }
          return exported;
        });
        const result: SnapshotQueryDetails = {
          mode: "snapshot",
          snapshot: {
            name: created.name,
            version: created.version,
            columns: created.columns,
            rowCount: created.rowCount,
            byteCount: created.byteCount,
            createdAt: created.createdAt,
            truncated: false,
            replaced: created.replaced,
          },
          preview: {
            rows: created.value.previewRows,
            rowCount: created.value.previewRows.length,
            truncated: created.rowCount > created.value.previewRows.length,
          },
          pythonInput: {
            rows: "snapshot_rows",
            rowShape: "list[dict]",
            rowAccess: "row['column_name']",
          },
        };
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
          details: result,
        };
      }
      const result = database.query(
        params.sql,
        params.parameters,
        { maxRows: params.limit ?? INLINE_MAX_ROWS },
      );
      signal?.throwIfAborted();
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
    label: "执行可信数据分析",
    description:
      "Execute Python in a strict, network-disabled sandbox for calculations, statistics, or PNG rendering. Optionally pass one session-scoped logical snapshot name from execute_sql.save_as. With a snapshot, use the pre-injected snapshot_rows directly: it is list[dict], so read values with row['column_name']; rows are already objects and must never be rebuilt with zip(columns, row). input_data supports both input_data.database and input_data['database']; without a snapshot, input_data.database is None and snapshot_rows is empty. input_data.user contains optional user_input. The tool never accepts or executes SQL. Call emit_result exactly once; it accepts a JSON value or summary/metrics/intermediates/data/notes keyword fields, supplies a default summary, and normalizes a string note into a list. print() is only for debug logs and does not replace emit_result. Guard empty collections before min/max or indexing. Every image must be emitted explicitly with emit_image(value, reference_name), where reference_name is a meaningful, specific English ASCII name whose normalized length does not exceed 50 characters, such as oee-ranking or availability-trend. Spaces and punctuation are normalized to lowercase hyphens; purely numeric, random, or generic names are not allowed. Matplotlib is configured for Simplified Chinese. matplotlib_chinese_font and chinese_font are pre-injected globals, not Python modules; never import them. The sandbox cannot access SQLite, project files, arbitrary host paths, or install packages.",
    promptSnippet: "在严格 Python 沙箱中计算或绘图,可按逻辑名称读取一个会话级数据快照",
    executionMode: "sequential",
    parameters: Type.Object({
      code: Type.String({ description: "Python source code to execute.", maxLength: 20_000 }),
      snapshot: Type.Optional(Type.String({
        description:
          "Logical data snapshot name returned by execute_sql.save_as. Omit for Python that does not need database data.",
        minLength: 1,
        maxLength: 64,
      })),
      user_input: Type.Optional(Type.Record(Type.String(), Type.Unknown(), {
        description: "Optional JSON object containing only values explicitly supplied by the user.",
      })),
    }),
    async execute(_toolCallId, params, signal) {
      if ("input_json" in (params as object)) {
        throw new CodeInterpreterError(
          "code_interpreter 已移除 input_json;数据库数据请通过 execute_sql.save_as 保存后按 snapshot 逻辑名称引用",
        );
      }
      if ("query" in (params as object)) {
        throw new CodeInterpreterError(
          "code_interpreter 不再接收 query;请先调用 execute_sql.save_as,再传入返回的 snapshot 逻辑名称",
        );
      }
      const userInput = normalizedUserInput(params.user_input);
      const snapshot = params.snapshot === undefined
        ? null
        : artifacts.resolveDataSnapshot(params.snapshot);
      signal?.throwIfAborted();
      const execution = await codeInterpreter.execute(params.code, {
        snapshot: snapshot === null
          ? null
          : {
            name: snapshot.name,
            version: snapshot.version,
            createdAt: snapshot.createdAt,
            databasePath: snapshot.filePath,
            rowCount: snapshot.rowCount,
            byteCount: snapshot.byteCount,
          },
        userInput,
      }, signal);
      const images = execution.details.images.map((image, index) => {
        if (!isGeneratedImageReferenceName(image.referenceName)) {
          throw new CodeInterpreterError(`第 ${index + 1} 张图片缺少有效的 reference_name`);
        }
        const referenceId = reserveSemanticGeneratedImageId(
          image.referenceName,
          usedGeneratedImageIds,
        );
        return { ...image, alt: image.referenceName, referenceId };
      });
      const details = { ...execution.details, images };
      const imageReferences = images.map((image) => {
        const id = image.referenceId;
        return { id, markdown: generatedImageMarkdown(id, image.alt) };
      });
      return {
        content: [{
          type: "text" as const,
          text: formatCodeInterpreterResult(details, imageReferences),
        }],
        details,
      };
    },
  });

  return [executeSqlTool, currentTimeTool, codeInterpreterTool];
}
