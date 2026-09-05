import path from "node:path";
import { AppDatabase } from "../../../data/database.ts";

const DEFAULT_DATABASE_PATH = ".data/database/oee.sqlite";

export function resolveTestOeeProjectRoot(moduleDirectory = import.meta.dirname): string {
  const sourceRoot = path.resolve(moduleDirectory, "../../../../..");
  return path.basename(sourceRoot) === "dist"
    ? path.resolve(sourceRoot, "..")
    : sourceRoot;
}

export function resolveTestOeeDatabasePath(
  override?: string,
  moduleDirectory = import.meta.dirname,
): string {
  return path.resolve(
    resolveTestOeeProjectRoot(moduleDirectory),
    override ?? process.env["SQL_WEB_DB_PATH"] ?? DEFAULT_DATABASE_PATH,
  );
}

export function withTestOeeDatabase<T>(
  operation: (database: AppDatabase) => T,
  override?: string,
): T {
  const database = AppDatabase.open({ filePath: resolveTestOeeDatabasePath(override) });
  try {
    return operation(database);
  } finally {
    database.close();
  }
}
