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
    assertSingleStatement(sql);
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
