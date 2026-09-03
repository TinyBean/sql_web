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
    database.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;");
    database.exec(readFileSync(schemaPath, "utf8"));
  } finally {
    database.close();
  }
}
