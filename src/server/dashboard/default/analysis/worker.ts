import { appendFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { DefaultDashboardAnalysisConfig } from "../config.ts";
import { buildDefaultDashboardInTransaction } from "../build.ts";
import { AnalysisEvidence } from "./evidence.ts";
import { applyAnalysisReport } from "./report.ts";

export interface AnalysisWorkerRequest {
  readonly databasePath: string;
  readonly throughDate: string;
  readonly now: string;
  readonly warnings: readonly string[];
  readonly config: DefaultDashboardAnalysisConfig;
  readonly runDir: string;
}

function send(message: unknown): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!process.send) { reject(new Error("每日分析需要 IPC 子进程入口")); return; }
    process.send(message, (error: Error | null) => error ? reject(error) : resolve());
  });
}

async function run(request: AnalysisWorkerRequest): Promise<void> {
  const database = new DatabaseSync(request.databasePath, { readOnly: true, timeout: 5000 });
  try {
    database.exec("PRAGMA query_only = ON; PRAGMA trusted_schema = OFF; BEGIN");
    const state = buildDefaultDashboardInTransaction(database, request.throughDate, new Date(request.now), request.warnings);
    await send({ type: "base", state });
    const log = (name: string, event: unknown): void => {
      appendFileSync(path.join(request.runDir, name + ".jsonl"), JSON.stringify({ at: new Date().toISOString(), ...event as object }) + "\n", { mode: 0o600 });
    };
    const evidence = new AnalysisEvidence(database, (record) => log("evidence", record));
    const context = evidence.context(state, request.throughDate);
    writeFileSync(path.join(request.runDir, "context.json"), JSON.stringify(context), { mode: 0o600 });
    // Load the model SDK only after the parent has a usable metrics dashboard.
    const { runAnalysisAgent } = await import("./agent.ts");
    let completed: Promise<void> | undefined;
    await runAnalysisAgent(request.config, context, evidence, (event) => log("events", event), (result) => {
      writeFileSync(path.join(request.runDir, "report.json"), JSON.stringify(result.report, null, 2), { mode: 0o600 });
      completed = send({ type: "analysis", state: applyAnalysisReport(state, result) });
    });
    await completed;
    database.exec("COMMIT");
  } finally {
    database.close();
  }
}

process.once("message", (request: AnalysisWorkerRequest) => {
  void run(request).catch(async (error: unknown) => {
    await send({ type: "failure", reason: error instanceof Error ? error.message : String(error) }).catch(() => {});
    process.exitCode = 1;
  }).finally(() => process.disconnect?.());
});
