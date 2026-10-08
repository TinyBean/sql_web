import { mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const sourceRoot = path.resolve(import.meta.dirname, "../..");
const projectRoot = path.basename(sourceRoot) === "dist"
  ? path.resolve(sourceRoot, "..")
  : sourceRoot;
const schemaPath = path.join(projectRoot, "scripts", "database", "schema.sql");

function hardenConnection(database: DatabaseSync): void {
  if ("enableDefensive" in database && typeof database.enableDefensive === "function") {
    database.enableDefensive(true);
  }
}

export function initializeOeeDatabase(databasePath: string): void {
  const resolvedDatabasePath = path.resolve(databasePath);
  mkdirSync(path.dirname(resolvedDatabasePath), { recursive: true });
  const database = new DatabaseSync(resolvedDatabasePath, {
    timeout: 5_000,
    enableForeignKeyConstraints: true,
  });
  try {
    hardenConnection(database);
    database.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; BEGIN IMMEDIATE;");
    try {
      database.exec(readFileSync(schemaPath, "utf8"));
      const columns = new Set(database.prepare("PRAGMA table_info(oee_import_windows)")
        .all().map((column) => column["name"]));
      for (const [name, definition] of [
        ["coverage_version", "INTEGER NOT NULL DEFAULT 0"],
        ["committed_dates_json", "TEXT NOT NULL DEFAULT '[]'"],
        ["incomplete_dates_json", "TEXT NOT NULL DEFAULT '[]'"],
        ["ignored_boundary_row_count", "INTEGER NOT NULL DEFAULT 0"],
      ]) {
        if (!columns.has(name)) database.exec(`ALTER TABLE oee_import_windows ADD COLUMN ${name} ${definition}`);
      }
      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
  } finally {
    database.close();
  }
}
