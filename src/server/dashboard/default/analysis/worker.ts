import { DatabaseSync } from "node:sqlite";
import type { DefaultDashboardAnalysisConfig } from "./index.ts";
import { calculateDefaultDashboard } from "../calculate/index.ts";
import { readDailyMachines } from "../calculate/daily-machines.ts";

export interface DefaultDashboardWorkerRequest {
  readonly databasePath: string;
  readonly throughDate: string;
  readonly now: string;
  readonly warnings: readonly string[];
  readonly config: DefaultDashboardAnalysisConfig;
  readonly runDir: string;
}

let validation: typeof import("./validation.ts") | undefined;

function send(message: unknown): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!process.send) { reject(new Error("每日分析需要 IPC 子进程入口")); return; }
    process.send(message, (error: Error | null) => error ? reject(error) : resolve());
  });
}

async function run(request: DefaultDashboardWorkerRequest, signal: AbortSignal): Promise<void> {
  const database = new DatabaseSync(request.databasePath, { readOnly: true, timeout: 5000 });
  try {
    database.exec("PRAGMA query_only = ON; PRAGMA trusted_schema = OFF; BEGIN");
    const machineRows = readDailyMachines(database, request.throughDate);
    const state = calculateDefaultDashboard(database, request.throughDate, new Date(request.now), request.warnings, machineRows);
    const deadline = Date.now() + request.config.timeoutMs;
    await send({ type: "base", state, deadline });
    // Model SDK loading must not delay delivery of the usable numeric snapshot.
    validation = await import("./validation.ts");
    const { analyzeCards } = await import("./agent.ts");
    let completed: Promise<void> | undefined;
    await analyzeCards(database, state, request.throughDate, request.config, request.runDir, (analyzed, quality) => {
      signal.throwIfAborted();
      completed = send({ type: "analysis", state: analyzed, quality });
    }, signal, deadline, (checkpoint, quality) => {
      completed = send({ type: "checkpoint", state: checkpoint, quality });
    }, machineRows);
    await completed;
    database.exec("COMMIT");
  } finally {
    database.close();
  }
}

process.once("message", (request: DefaultDashboardWorkerRequest) => {
  const controller = new AbortController();
  const stop = (): void => controller.abort();
  process.once("SIGTERM", stop);
  void run(request, controller.signal).catch(async (error: unknown) => {
    const reason = error instanceof Error ? error.message : String(error);
    await send({ type: "failure", reason,
      ...(validation ? { validation: validation.validationFeedback(error instanceof validation.AnalysisValidationError ? error.issues : [], {
        ...(error instanceof validation.AnalysisValidationError ? { has_more: error.has_more } : {}), reason,
      }) } : {}),
    }).catch(() => {});
    process.exitCode = 1;
  }).finally(() => { process.off("SIGTERM", stop); process.disconnect?.(); });
});
