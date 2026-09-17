import { fork } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { AppLogger } from "../../../logger.ts";
import { parseDashboardState, type DashboardState } from "../../../../shared/dashboard.ts";
import type { DefaultDashboardGenerationConfig } from "../config.ts";
import type { AnalysisWorkerRequest } from "./worker.ts";
import { analysisUnavailable } from "./report.ts";
import { readAnalysisEvents, summarizeAnalysisEvents } from "./metrics.ts";

export interface DailyAnalysisResult {
  readonly state: DashboardState;
  readonly analysisStatus: "completed" | "failed" | "timed_out";
  readonly analysisReason: string | null;
  readonly analysisRunId: string;
  readonly analysisArtifactDir: string;
}

export async function generateAnalyzedDashboard(
  config: DefaultDashboardGenerationConfig, throughDate: string, now: Date, warnings: readonly string[], logger: AppLogger,
  runId: string = randomUUID(), workerUrl = new URL("./worker.ts", import.meta.url),
): Promise<DailyAnalysisResult> {
  if (!/^[a-zA-Z0-9_-]+$/u.test(runId)) throw new Error("无效的分析运行 ID");
  // TypeScript rewrites import specifiers but not URLs in compiled test builds.
  if (import.meta.url.endsWith(".js") && workerUrl.pathname.endsWith("/worker.ts")) {
    workerUrl = new URL("./worker.js", import.meta.url);
  }
  const runDir = path.join(config.analysis.artifactDir, runId);
  mkdirSync(runDir, { recursive: true, mode: 0o700 });
  const started = Date.now();
  const metadata = {
    runId, throughDate, startedAt: new Date(started).toISOString(),
    provider: config.analysis.provider, model: config.analysis.model,
    timeoutMs: config.analysis.timeoutMs,
  };
  const saveOutcome = (status: string, reason: string | null): void => writeFileSync(
    path.join(runDir, "run.json"), JSON.stringify({ ...metadata, status, reason, durationMs: Date.now() - started }, null, 2), { mode: 0o600 },
  );
  saveOutcome("running", null);
  logger.info("daily.analysis.started", { ...metadata, runDir });
  return new Promise((resolve, reject) => {
    let base: DashboardState | undefined;
    let baseReadyAt: number | undefined;
    let analyzed: DashboardState | undefined;
    let failure: string | null = null;
    let timedOut = false;
    let stderr = "";
    let killTimer: NodeJS.Timeout | undefined;
    const child = fork(workerUrl, [], {
      cwd: config.analysis.cwd, execPath: process.execPath,
      // Resolve from this module: analysis may run with a different working directory.
      execArgv: workerUrl.pathname.endsWith(".ts") ? ["--import", import.meta.resolve("tsx")] : [],
      stdio: ["ignore", "ignore", "pipe", "ipc"],
    });
    const stop = (): void => {
      child.kill("SIGTERM");
      killTimer ??= setTimeout(() => child.kill("SIGKILL"), 1000);
    };
    const timeout = (): void => {
      timedOut = true;
      failure = base ? "临时 Agent 分析超时" : "基础看板计算超时";
      stop();
    };
    // Calculation also has a watchdog, independently of the analysis allowance.
    let timer = setTimeout(timeout, config.analysis.timeoutMs);
    child.stderr?.on("data", (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(-8000); });
    child.on("error", (error) => { failure = error.message; });
    child.on("message", (message: unknown) => {
      if (timedOut || analyzed || failure) return;
      try {
        if (!message || typeof message !== "object" || !("type" in message)) throw new Error("无效的分析子进程消息");
        if (message.type === "base" && "state" in message && !base) {
          base = parseDashboardState(message.state);
          baseReadyAt = Date.now();
          writeFileSync(path.join(runDir, "base-dashboard.json"), JSON.stringify(base), { mode: 0o600 });
          clearTimeout(timer);
          timer = setTimeout(timeout, config.analysis.timeoutMs);
          logger.info("daily.analysis.base_ready", { runId, throughDate });
        } else if (message.type === "analysis" && "state" in message && base) {
          analyzed = parseDashboardState(message.state);
          clearTimeout(timer);
          // Give SDK cleanup a brief chance; do not leave a finished worker alive.
          timer = setTimeout(stop, 2000);
        } else if (message.type === "failure" && "reason" in message) {
          failure = String(message.reason);
          stop();
        } else throw new Error("分析子进程消息顺序无效");
      } catch (error) {
        failure = error instanceof Error ? error.message : String(error);
        analyzed = undefined;
        stop();
      }
    });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      try {
        writeFileSync(path.join(runDir, "metrics.json"), JSON.stringify(summarizeAnalysisEvents(
          readAnalysisEvents(path.join(runDir, "events.jsonl")), started, Date.now(), baseReadyAt,
        ), null, 2), { mode: 0o600 });
        if (stderr) writeFileSync(path.join(runDir, "worker-stderr.log"), stderr, { mode: 0o600 });
        if (!base) {
          const reason = failure ?? "基础看板计算失败 (" + (signal ?? code) + ")";
          saveOutcome("calculation_failed", reason);
          reject(new Error(reason));
          return;
        }
        const analysisStatus = analyzed ? "completed" : timedOut ? "timed_out" : "failed";
        const analysisReason = analyzed ? null : failure ?? "分析子进程未提交有效报告 (" + (signal ?? code) + ")";
        saveOutcome(analysisStatus, analysisReason);
        logger.info("daily.analysis.completed", { runId, analysisStatus, analysisReason, durationMs: Date.now() - started, runDir });
        resolve({
          state: analyzed ?? analysisUnavailable(base, analysisReason!),
          analysisStatus, analysisReason, analysisRunId: runId, analysisArtifactDir: runDir,
        });
      } catch (error) { reject(error); }
    });
    const request: AnalysisWorkerRequest = {
      databasePath: config.databasePath, throughDate, now: now.toISOString(), warnings, config: config.analysis, runDir,
    };
    child.send(request, (error: Error | null) => { if (error) { failure = error.message; stop(); } });
  });
}
