import { AppDatabase, DatabaseInputError, type QueryJsonExportOptions, type QueryOptions, type SqlParameter } from "./database.ts";

export type QueryOperation =
  | { kind: "schema" }
  | { kind: "query"; sql: string; parameters: readonly SqlParameter[]; options: QueryOptions }
  | { kind: "export"; sql: string; parameters: readonly SqlParameter[]; options: Omit<QueryJsonExportOptions, "signal" | "fileDescriptor"> };

export interface QueryRequest {
  filePath: string;
  operation: QueryOperation;
}

// The fourth stdio entry is the parent's private staging file. IPC has its own entry.
const EXPORT_FD = 3;

function execute({ filePath, operation }: QueryRequest) {
  const database = AppDatabase.open({ filePath });
  try {
    switch (operation.kind) {
      case "schema": return database.getSchema();
      case "query": return database.query(operation.sql, operation.parameters, operation.options);
      case "export": return database.exportQueryJson(operation.sql, operation.parameters, {
        ...operation.options, fileDescriptor: EXPORT_FD,
      });
    }
  } finally {
    database.close();
  }
}

process.once("message", (request: QueryRequest) => {
  let reply;
  try {
    reply = { ok: true, value: execute(request) };
  } catch (error) {
    reply = { ok: false, inputError: error instanceof DatabaseInputError,
      message: error instanceof Error ? error.message : String(error) };
  }
  process.send!(reply, () => process.disconnect());
});
