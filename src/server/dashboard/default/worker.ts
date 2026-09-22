import { DatabaseSync } from "node:sqlite";
import { parseDashboardState } from "../../../shared/dashboard.ts";
import type { DefaultDashboardAnalysisConfig } from "./config.ts";
import { createDefaultDashboard } from "./template.ts";
import { calculateNumericCards } from "./calculate.ts";
import { dashboardPeriods } from "./periods.ts";
import { prepareAnalysisCards, analyzeCards } from "./analysis/index.ts";

export interface DefaultDashboardWorkerRequest {
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

async function run(request: DefaultDashboardWorkerRequest, signal: AbortSignal): Promise<void> {
  const database = new DatabaseSync(request.databasePath, { readOnly: true, timeout: 5000 });
  try {
    database.exec("PRAGMA query_only = ON; PRAGMA trusted_schema = OFF; BEGIN");
    const template = createDefaultDashboard(new Date(request.now));
    const numericCards = calculateNumericCards(database, request.throughDate, request.warnings);
    const analysisCards = prepareAnalysisCards(database, request.throughDate, request.warnings);
    const state = parseDashboardState({ ...template, dateRange: dashboardPeriods(request.throughDate).trend,
      widgets: [...numericCards, ...analysisCards] });
    await send({ type: "base", state });
    let completed: Promise<void> | undefined;
    await analyzeCards(database, state, request.throughDate, request.config, request.runDir, (analyzed) => {
      completed = send({ type: "analysis", state: analyzed });
    }, signal);
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
    await send({ type: "failure", reason: error instanceof Error ? error.message : String(error) }).catch(() => {});
    process.exitCode = 1;
  }).finally(() => { process.off("SIGTERM", stop); process.disconnect?.(); });
});
