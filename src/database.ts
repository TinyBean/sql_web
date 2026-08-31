import { mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { SchemaObject } from "../shared/contracts.js";

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
  filePath: string;
  schemaPath: string;
  seedPath: string;
}

export interface QueryOptions {
  maxRows?: number;
}

export interface QueryResult {
  columns: string[];
  rows: NormalizedRow[];
  rowCount: number;
  truncated: boolean;
}

export interface ExecuteResult {
  changes: number;
  lastInsertRowid: string | number;
}

const DEFAULT_MAX_ROWS = 100;
const ABSOLUTE_MAX_ROWS = 200;
const MAX_SQL_BYTES = 20_000;
const ALLOWED_WRITE_KEYWORDS = new Set(["INSERT", "UPDATE", "DELETE", "REPLACE"]);

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

function stripLeadingTrivia(sql: string): string {
  let rest = sql;
  while (true) {
    const before = rest;
    rest = rest.replace(/^\s+/u, "");
    rest = rest.replace(/^--[^\r\n]*(?:\r?\n|$)/u, "");
    rest = rest.replace(/^\/\*[\s\S]*?\*\//u, "");
    if (rest === before) return rest;
  }
}

function assertAllowedWrite(sql: string): void {
  const keyword = /^([A-Za-z]+)/u.exec(stripLeadingTrivia(sql))?.[1]?.toUpperCase();
  if (!keyword || !ALLOWED_WRITE_KEYWORDS.has(keyword)) {
    throw new DatabaseInputError(
      "执行工具只允许 INSERT、UPDATE、DELETE 或 REPLACE；读取数据请使用查询工具",
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

function normalizeLastInsertRowId(value: number | bigint): string | number {
  return typeof value === "bigint" && (value > Number.MAX_SAFE_INTEGER || value < Number.MIN_SAFE_INTEGER)
    ? value.toString()
    : Number(value);
}

function normalizeRow(row: Record<string, unknown>): NormalizedRow {
  return Object.fromEntries(Object.entries(row).map(([key, value]) => [key, normalizeValue(value)]));
}

function configureConnection(database: DatabaseSync): void {
  database.exec("PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
  // enableDefensive() exists in newer Node releases but not in the Node 22
  // type surface supported by this project. Keep the extra hardening when present.
  const defensiveDatabase = database as DatabaseSync & { enableDefensive?: (enabled: boolean) => void };
  defensiveDatabase.enableDefensive?.(true);
}

export class DemoDatabase {
  readonly filePath: string;
  readonly schemaPath: string;
  readonly seedPath: string;
  #writer: DatabaseSync | undefined;
  #reader: DatabaseSync | undefined;

  constructor({ filePath, schemaPath, seedPath }: DatabaseOptions) {
    this.filePath = path.resolve(filePath);
    this.schemaPath = path.resolve(schemaPath);
    this.seedPath = path.resolve(seedPath);
  }

  initialize(): this {
    mkdirSync(path.dirname(this.filePath), { recursive: true });
    this.#writer = new DatabaseSync(this.filePath);
    configureConnection(this.#writer);
    this.#writer.exec(readFileSync(this.schemaPath, "utf8"));
    this.#writer.exec(readFileSync(this.seedPath, "utf8"));

    this.#reader = new DatabaseSync(this.filePath, { readOnly: true });
    configureConnection(this.#reader);
    return this;
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
      throw new DatabaseInputError("查询工具只接受会返回结果集的只读 SQL");
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

  execute(sql: string, parameters?: readonly SqlParameter[]): ExecuteResult {
    const { writer } = this.#connections();
    assertSingleStatement(sql);
    assertAllowedWrite(sql);
    const statement = writer.prepare(sql);
    const bound = bindParameters(parameters);

    writer.exec("BEGIN IMMEDIATE");
    try {
      const result = statement.run(...bound);
      writer.exec("COMMIT");
      return {
        changes: Number(result.changes),
        lastInsertRowid: normalizeLastInsertRowId(result.lastInsertRowid),
      };
    } catch (error) {
      writer.exec("ROLLBACK");
      throw error;
    }
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
      const type = object.type;
      const name = object.name;
      if ((type !== "table" && type !== "view") || typeof name !== "string") {
        throw new Error("数据库返回了无法识别的 Schema 元数据");
      }
      return {
      type,
      name,
      sql: typeof object.sql === "string" ? object.sql : null,
      columns: reader
        .prepare("SELECT name, type, \"notnull\", pk FROM pragma_table_info(?) ORDER BY cid")
        .all(name)
        .map((column) => ({
          name: String(column.name),
          type: String(column.type),
          nullable: column.notnull === 0,
          primaryKey: typeof column.pk === "number" && column.pk > 0,
        })),
      };
    });
  }

  close(): void {
    this.#reader?.close();
    this.#writer?.close();
    this.#reader = undefined;
    this.#writer = undefined;
  }

  #connections(): { writer: DatabaseSync; reader: DatabaseSync } {
    if (!this.#writer || !this.#reader) throw new Error("数据库尚未初始化");
    return { writer: this.#writer, reader: this.#reader };
  }
}
