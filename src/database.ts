import { mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { SchemaObject } from "../shared/contracts.ts";

export type SqlParameter = string | number | bigint | boolean | null | Uint8Array;
type BoundSqlParameter = Exclude<SqlParameter, boolean>;
type NormalizedValue = string | number | null;
type NormalizedRow = Record<string, NormalizedValue>;
type ScannerState =
  | "normal"
  | "line-comment"
  | "block-comment"
  | "single-quote"
  | "double-quote"
  | "backtick"
  | "bracket";

interface SqlToken {
  readonly kind: "word" | "symbol";
  readonly value: string;
  readonly depth: number;
}

export interface DatabaseOptions {
  readonly filePath: string;
  readonly schemaPath: string;
}

export interface QueryOptions {
  readonly maxRows?: number;
}

export interface QueryResult {
  readonly columns: readonly string[];
  readonly rows: readonly NormalizedRow[];
  readonly rowCount: number;
  readonly truncated: boolean;
}

const DEFAULT_MAX_ROWS = 100;
const ABSOLUTE_MAX_ROWS = 200;
const MAX_SQL_BYTES = 20_000;
const QUERY_KEYWORDS = new Set(["SELECT", "VALUES"]);
const STATEMENT_KEYWORDS = new Set(["SELECT", "VALUES", "INSERT", "UPDATE", "DELETE", "REPLACE"]);
const READ_ONLY_PRAGMAS_WITHOUT_ARGUMENTS = new Set([
  "APPLICATION_ID",
  "COLLATION_LIST",
  "COMPILE_OPTIONS",
  "DATA_VERSION",
  "DATABASE_LIST",
  "FOREIGN_KEYS",
  "FREELIST_COUNT",
  "FUNCTION_LIST",
  "MODULE_LIST",
  "PAGE_COUNT",
  "PRAGMA_LIST",
  "SCHEMA_VERSION",
  "USER_VERSION",
]);
const READ_ONLY_PRAGMAS_WITH_OPTIONAL_ARGUMENTS = new Set([
  "FOREIGN_KEY_CHECK",
  "FOREIGN_KEY_LIST",
  "INDEX_INFO",
  "INDEX_LIST",
  "INDEX_XINFO",
  "INTEGRITY_CHECK",
  "QUICK_CHECK",
  "TABLE_INFO",
  "TABLE_LIST",
  "TABLE_XINFO",
]);

export class DatabaseInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DatabaseInputError";
  }
}

function checkSqlSize(sql: string): void {
  if (typeof sql !== "string" || !sql.trim()) {
    throw new DatabaseInputError("SQL 不能为空");
  }
  if (Buffer.byteLength(sql, "utf8") > MAX_SQL_BYTES) {
    throw new DatabaseInputError(`SQL 不能超过 ${MAX_SQL_BYTES} 字节`);
  }
  if (sql.includes("\0")) {
    throw new DatabaseInputError("SQL 不能包含空字节");
  }
}

/**
 * SQLite's prepare() accepts the first statement and ignores trailing SQL. This
 * scanner makes the one-statement invariant explicit without trying to parse SQL.
 */
export function assertSingleStatement(sql: string): void {
  checkSqlSize(sql);
  let state: ScannerState = "normal";
  let terminated = false;

  for (let index = 0; index < sql.length; index += 1) {
    const char = sql.charAt(index);
    const next = sql.charAt(index + 1);

    if (state === "line-comment") {
      if (char === "\n" || char === "\r") state = "normal";
      continue;
    }
    if (state === "block-comment") {
      if (char === "*" && next === "/") {
        state = "normal";
        index += 1;
      }
      continue;
    }
    if (state === "single-quote") {
      if (char === "'" && next === "'") index += 1;
      else if (char === "'") state = "normal";
      continue;
    }
    if (state === "double-quote") {
      if (char === '"' && next === '"') index += 1;
      else if (char === '"') state = "normal";
      continue;
    }
    if (state === "backtick") {
      if (char === "`" && next === "`") index += 1;
      else if (char === "`") state = "normal";
      continue;
    }
    if (state === "bracket") {
      if (char === "]") state = "normal";
      continue;
    }

    if (/\s/u.test(char)) continue;
    if (char === "-" && next === "-") {
      state = "line-comment";
      index += 1;
      continue;
    }
    if (char === "/" && next === "*") {
      state = "block-comment";
      index += 1;
      continue;
    }
    if (char === ";") {
      terminated = true;
      continue;
    }
    if (terminated) {
      throw new DatabaseInputError("每次只能执行一条 SQL 语句");
    }
    if (char === "'") state = "single-quote";
    else if (char === '"') state = "double-quote";
    else if (char === "`") state = "backtick";
    else if (char === "[") state = "bracket";
  }
}

function tokenizeSql(sql: string): SqlToken[] {
  const tokens: SqlToken[] = [];
  let state: ScannerState = "normal";
  let depth = 0;

  for (let index = 0; index < sql.length; index += 1) {
    const char = sql.charAt(index);
    const next = sql.charAt(index + 1);

    if (state === "line-comment") {
      if (char === "\n" || char === "\r") state = "normal";
      continue;
    }
    if (state === "block-comment") {
      if (char === "*" && next === "/") {
        state = "normal";
        index += 1;
      }
      continue;
    }
    if (state === "single-quote") {
      if (char === "'" && next === "'") index += 1;
      else if (char === "'") state = "normal";
      continue;
    }
    if (state === "double-quote") {
      if (char === '"' && next === '"') index += 1;
      else if (char === '"') state = "normal";
      continue;
    }
    if (state === "backtick") {
      if (char === "`" && next === "`") index += 1;
      else if (char === "`") state = "normal";
      continue;
    }
    if (state === "bracket") {
      if (char === "]") state = "normal";
      continue;
    }

    if (char === "-" && next === "-") {
      state = "line-comment";
      index += 1;
      continue;
    }
    if (char === "/" && next === "*") {
      state = "block-comment";
      index += 1;
      continue;
    }
    if (char === "'") {
      state = "single-quote";
      continue;
    }
    if (char === '"') {
      state = "double-quote";
      continue;
    }
    if (char === "`") {
      state = "backtick";
      continue;
    }
    if (char === "[") {
      state = "bracket";
      continue;
    }
    if (/[A-Za-z_]/u.test(char)) {
      let end = index + 1;
      while (/[A-Za-z0-9_$]/u.test(sql.charAt(end))) end += 1;
      tokens.push({ kind: "word", value: sql.slice(index, end).toUpperCase(), depth });
      index = end - 1;
      continue;
    }
    if (char === "(") {
      tokens.push({ kind: "symbol", value: char, depth });
      depth += 1;
      continue;
    }
    if (char === ")") {
      depth = Math.max(0, depth - 1);
      tokens.push({ kind: "symbol", value: char, depth });
      continue;
    }
    if (char === "." || char === "=" || char === ",") {
      tokens.push({ kind: "symbol", value: char, depth });
    }
  }

  return tokens;
}

function mainStatementKeyword(tokens: readonly SqlToken[], start: number): string | undefined {
  const first = tokens[start];
  if (first?.kind !== "word") return undefined;
  if (first.value !== "WITH") return first.value;

  for (let index = start + 1; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token?.kind === "word" && token.depth === 0 && STATEMENT_KEYWORDS.has(token.value)) {
      return token.value;
    }
  }
  return undefined;
}

function isReadOnlyPragma(tokens: readonly SqlToken[]): boolean {
  let nameIndex = 1;
  if (
    tokens[1]?.kind === "word" && tokens[2]?.value === "." && tokens[3]?.kind === "word"
  ) {
    nameIndex = 3;
  }
  const name = tokens[nameIndex];
  if (name?.kind !== "word") return false;

  const remaining = tokens.slice(nameIndex + 1);
  if (remaining.some((token) => token.value === "=")) return false;
  if (remaining.length === 0) {
    return READ_ONLY_PRAGMAS_WITHOUT_ARGUMENTS.has(name.value) ||
      READ_ONLY_PRAGMAS_WITH_OPTIONAL_ARGUMENTS.has(name.value);
  }
  return READ_ONLY_PRAGMAS_WITH_OPTIONAL_ARGUMENTS.has(name.value) &&
    remaining[0]?.value === "(" && remaining.at(-1)?.value === ")";
}

/** Reject every statement that is not an explicitly recognized read-only query. */
export function assertReadOnlyQuery(sql: string): void {
  assertSingleStatement(sql);
  const tokens = tokenizeSql(sql);
  const first = tokens[0];
  let allowed = false;

  if (first?.kind === "word" && first.value === "PRAGMA") {
    allowed = isReadOnlyPragma(tokens);
  } else {
    let statementStart = 0;
    if (first?.kind === "word" && first.value === "EXPLAIN") {
      statementStart = 1;
      if (tokens[statementStart]?.value === "QUERY") {
        if (tokens[statementStart + 1]?.value !== "PLAN") statementStart = -1;
        else statementStart += 2;
      }
    }
    if (statementStart >= 0) {
      const keyword = mainStatementKeyword(tokens, statementStart);
      allowed = keyword !== undefined && QUERY_KEYWORDS.has(keyword);
    }
  }

  if (!allowed) {
    throw new DatabaseInputError(
      "SQL 工具仅允许执行 SELECT、WITH、VALUES、只读 PRAGMA 或对应的 EXPLAIN 查询",
    );
  }
}

function normalizeParameter(value: SqlParameter): BoundSqlParameter {
  if (typeof value === "boolean") return value ? 1 : 0;
  return value;
}

function bindParameters(parameters?: readonly SqlParameter[]): BoundSqlParameter[] {
  if (parameters === undefined) return [];
  if (!Array.isArray(parameters)) {
    throw new DatabaseInputError("parameters 必须是数组");
  }
  return parameters.map(normalizeParameter);
}

function normalizeValue(value: unknown): NormalizedValue {
  if (typeof value === "bigint") {
    return value <= Number.MAX_SAFE_INTEGER && value >= Number.MIN_SAFE_INTEGER
      ? Number(value)
      : value.toString();
  }
  if (value instanceof Uint8Array) return `[BLOB ${value.byteLength} bytes]`;
  if (typeof value === "string" && value.length > 2_000) return `${value.slice(0, 2_000)}…`;
  if (value === null || typeof value === "number") return value;
  return String(value);
}

function normalizeRow(row: Record<string, unknown>): NormalizedRow {
  return Object.fromEntries(Object.entries(row).map(([key, value]) => [key, normalizeValue(value)]));
}

function configureConnection(database: DatabaseSync): void {
  database.exec("PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
  // enableDefensive() exists in newer Node releases but not in the Node 22
  // type surface supported by this project. Keep the extra hardening when present.
  if ("enableDefensive" in database && typeof database.enableDefensive === "function") {
    database.enableDefensive(true);
  }
}

export class AppDatabase {
  readonly filePath: string;
  readonly schemaPath: string;
  #reader: DatabaseSync | null;

  private constructor(options: DatabaseOptions, reader: DatabaseSync) {
    this.filePath = options.filePath;
    this.schemaPath = options.schemaPath;
    this.#reader = reader;
  }

  static open({ filePath, schemaPath }: DatabaseOptions): AppDatabase {
    const options: DatabaseOptions = {
      filePath: path.resolve(filePath),
      schemaPath: path.resolve(schemaPath),
    };
    mkdirSync(path.dirname(options.filePath), { recursive: true });
    let writer: DatabaseSync | undefined;
    let reader: DatabaseSync | undefined;
    try {
      writer = new DatabaseSync(options.filePath);
      configureConnection(writer);
      writer.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;");
      writer.exec(readFileSync(options.schemaPath, "utf8"));
      writer.close();
      writer = undefined;

      reader = new DatabaseSync(options.filePath, { readOnly: true });
      configureConnection(reader);
      return new AppDatabase(options, reader);
    } catch (error) {
      reader?.close();
      writer?.close();
      throw error;
    }
  }

  query(sql: string, parameters?: readonly SqlParameter[], options: QueryOptions = {}): QueryResult {
    const { reader } = this.#connections();
    assertReadOnlyQuery(sql);
    const requestedLimit = Number(options.maxRows ?? DEFAULT_MAX_ROWS);
    const maxRows = Number.isInteger(requestedLimit)
      ? Math.min(Math.max(requestedLimit, 1), ABSOLUTE_MAX_ROWS)
      : DEFAULT_MAX_ROWS;
    const statement = reader.prepare(sql);
    const columns = statement.columns().map((column) => column.name);
    if (columns.length === 0) {
      throw new DatabaseInputError("SQL 工具只接受会返回结果集的只读 SQL");
    }
    statement.setReadBigInts(true);

    const rows: NormalizedRow[] = [];
    let truncated = false;
    for (const row of statement.iterate(...bindParameters(parameters))) {
      if (rows.length === maxRows) {
        truncated = true;
        break;
      }
      rows.push(normalizeRow(row));
    }
    return { columns, rows, rowCount: rows.length, truncated };
  }

  getSchema(): SchemaObject[] {
    const { reader } = this.#connections();
    const objects = reader
      .prepare(
        `SELECT type, name, sql
         FROM sqlite_master
         WHERE type IN ('table', 'view') AND name NOT LIKE 'sqlite_%'
         ORDER BY type, name`,
      )
      .all();

    return objects.map((object): SchemaObject => {
      const type = object["type"];
      const name = object["name"];
      if ((type !== "table" && type !== "view") || typeof name !== "string") {
        throw new Error("数据库返回了无法识别的 Schema 元数据");
      }
      return {
        type,
        name,
        sql: typeof object["sql"] === "string" ? object["sql"] : null,
        columns: reader
          .prepare("SELECT name, type, \"notnull\", pk FROM pragma_table_info(?) ORDER BY cid")
          .all(name)
          .map((column) => ({
            name: String(column["name"]),
            type: String(column["type"]),
            nullable: column["notnull"] === 0,
            primaryKey: typeof column["pk"] === "number" && column["pk"] > 0,
          })),
      };
    });
  }

  close(): void {
    this.#reader?.close();
    this.#reader = null;
  }

  #connections(): { reader: DatabaseSync } {
    if (!this.#reader) throw new Error("数据库尚未初始化");
    return { reader: this.#reader };
  }
}
