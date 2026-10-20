import { fork } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { AppLogger } from "../../../logger.ts";
import { parseDashboardState, type DashboardState } from "../../../../shared/dashboard.ts";
import type { DefaultDashboardWorkerRequest } from "./worker.ts";
import { analysisUnavailable, analysisExclusionSummary, type AnalysisPublication, type AnalysisExclusionSummary } from "./validation.ts";

export interface DefaultDashboardAnalysisConfig {
  readonly cwd: string;
  readonly agentDir: string;
  readonly artifactDir: string;
  readonly provider: string;
  readonly model: string;
  readonly timeoutMs: number;
  readonly contextWindow: number;
  readonly maxOutputTokens: number;
  readonly codeInterpreter: {
    readonly pythonPath: string;
    readonly bwrapPath: string;
    readonly prlimitPath: string;
  };
}

export interface DefaultDashboardGenerationConfig {
  readonly databasePath: string;
  readonly analysis: DefaultDashboardAnalysisConfig;
}

export interface DefaultDashboardResult {
  readonly state: DashboardState;
  readonly analysisStatus: "completed" | "degraded" | "failed" | "timed_out";
  readonly analysisReason: string | null;
  readonly analysisExclusions?: readonly AnalysisExclusionSummary[];
  readonly analysisRunId: string;
  readonly analysisArtifactDir: string;
}

export async function generateDefaultDashboard(
  config: DefaultDashboardGenerationConfig, throughDate: string, now: Date, warnings: readonly string[], logger: AppLogger,
  runId: string = randomUUID(), workerUrl = new URL("./worker.ts", import.meta.url),
): Promise<DefaultDashboardResult> {
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
  let quality: AnalysisPublication = { status: "completed", exclusions: [] };
  const saveOutcome = (status: string, reason: string | null): void => writeFileSync(
    path.join(runDir, "run.json"), JSON.stringify({ ...metadata, status, reason, analysisExclusions: quality.exclusions, durationMs: Date.now() - started }, null, 2), { mode: 0o600 },
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
          const deadline = "deadline" in message && typeof message.deadline === "number" ? message.deadline : Date.now() + config.analysis.timeoutMs;
          timer = setTimeout(timeout, Math.max(0, deadline - Date.now()));
          logger.info("daily.analysis.base_ready", { runId, throughDate });
        } else if (message.type === "analysis" && "state" in message && base) {
          if ("quality" in message) {
            const supplied = message.quality as AnalysisPublication;
            if (!supplied || !["completed", "degraded"].includes(supplied.status) || !Array.isArray(supplied.exclusions)) throw new Error("无效的分析质量状态");
            quality = supplied;
          }
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
        const analysisStatus = analyzed ? quality.status : timedOut ? "timed_out" : "failed";
        const analysisReason = analyzed ? (quality.status === "degraded" ? analysisExclusionSummary(quality.exclusions) : null) : failure ?? "分析子进程未提交有效报告 (" + (signal ?? code) + ")";
        saveOutcome(analysisStatus, analysisReason);
        logger.info("daily.analysis.completed", { runId, analysisStatus, analysisReason, durationMs: Date.now() - started, runDir });
        resolve({
          state: analyzed ?? analysisUnavailable(base, analysisReason!),
          analysisStatus, analysisReason, analysisExclusions: quality.exclusions, analysisRunId: runId, analysisArtifactDir: runDir,
        });
      } catch (error) { reject(error); }
    });
    const request: DefaultDashboardWorkerRequest = {
      databasePath: config.databasePath, throughDate, now: now.toISOString(), warnings, config: config.analysis, runDir,
    };
    child.send(request, (error: Error | null) => { if (error) { failure = error.message; stop(); } });
  });
}

type Event = Record<string, unknown>;
const timestamp = (value: unknown): number => typeof value === "string" ? Date.parse(value) : NaN;
const object = (value: unknown): Event => value !== null && typeof value === "object" ? value as Event : {};

export function readAnalysisEvents(filePath: string): Event[] {
  if (!existsSync(filePath)) return [];
  return readFileSync(filePath, "utf8").split("\n").filter(Boolean).flatMap((line) => {
    try { return [JSON.parse(line) as Event]; } catch { return []; } // A killed worker can leave a partial final line.
  });
}

/** Client-observed intervals include request waiting, generation, and any SDK retries. */
function summarizeAgentEvents(events: readonly Event[], startedAt: number, endedAt: number, baseReadyAt?: number) {
  const tools: Record<string, { calls: number; errors: number; durationMs: number }> = {};
  const turns: { turnId: number; phase: string; durationMs: number; inputTokens: number; outputTokens: number }[] = [];
  const activeTools = new Map<string, { at: number; name: string }>();
  let sessionAt: number | undefined;
  let modelStart: number | undefined;
  let lastBoundary = startedAt;
  let draft = false;
  let accepted = false;
  let retryCount = 0;
  let compactionCount = 0;
  for (const event of events) {
    const at = timestamp(event["at"]);
    if (!Number.isFinite(at)) continue;
    const type = event["type"];
    if (type === "session") { sessionAt = at; lastBoundary = at; modelStart = at; }
    else if (type === "model_turn_start") modelStart = at;
    else if (type === "analysis_draft") draft = true;
    else if (type === "analysis_accepted") { accepted = true; modelStart = undefined; lastBoundary = at; }
    else if (type === "auto_retry_start") retryCount += 1;
    else if (type === "compaction_start") compactionCount += 1;
    else if (type === "subagent_result") { accepted = true; modelStart = undefined; lastBoundary = at; }
    else if (type === "assistant") {
      const message = object(event["message"]);
      const usage = object(message["usage"]);
      const parts = Array.isArray(message["content"]) ? message["content"].map(object) : [];
      const names = parts.filter((part) => part["type"] === "toolCall").map((part) => part["name"]);
      // Older workers labelled draft submissions as investigation; keep their original metrics.
      const legacyPhase = names.includes("finalize_analysis") ? "review" : (names.includes("submit_analysis") || names.includes("repair_analysis_group"))
        ? (draft ? "review" : "draft") : draft ? "review_investigation" : "investigation";
      const phase = event["phase"] === "aggregation" || event["phase"] === "submission" ? event["phase"] : legacyPhase;
      if (Number(usage["output"] ?? 0) || Number(usage["input"] ?? 0) || parts.length || message["stopReason"] === "error") {
        turns.push({ turnId: Number(event["turnId"] ?? turns.length + 1),
          phase,
          durationMs: Math.max(0, at - (modelStart ?? lastBoundary)),
          inputTokens: Number(usage["input"] ?? 0), outputTokens: Number(usage["output"] ?? 0) });
      }
      modelStart = undefined;
      lastBoundary = at;
    } else if (type === "tool_call") {
      const name = String(event["name"]);
      (tools[name] ??= { calls: 0, errors: 0, durationMs: 0 }).calls += 1;
      activeTools.set(String(event["toolCallId"] ?? "legacy"), { at, name });
      modelStart = undefined;
    } else if (type === "tool_result") {
      const key = String(event["toolCallId"] ?? "legacy");
      const call = activeTools.get(key);
      const name = String(event["name"]);
      const stats = tools[name] ??= { calls: 0, errors: 0, durationMs: 0 };
      if (call) stats.durationMs += Math.max(0, at - call.at);
      if (event["isError"]) stats.errors += 1;
      activeTools.delete(key);
      accepted ||= object(object(event["result"])["details"])["accepted"] === true;
      lastBoundary = at;
    }
  }
  const phaseMs: Record<string, number> = {};
  for (const turn of turns) phaseMs[turn.phase] = (phaseMs[turn.phase] ?? 0) + turn.durationMs;
  const pending = [...activeTools.values()].map((call) => ({ kind: "tool", name: call.name, durationMs: Math.max(0, endedAt - call.at) }));
  if (!accepted && modelStart !== undefined) pending.push({ kind: "model", name: "client_observed", durationMs: Math.max(0, endedAt - modelStart) });
  // Older workers did not emit request starts; mark their tail as unknown, not model generation.
  if (!accepted && !pending.length && endedAt - lastBoundary > 1000) pending.push({ kind: "unknown", name: "unobserved_tail", durationMs: endedAt - lastBoundary });
  return { schemaVersion: 1, timingDefinition: "client-observed; model intervals include waiting/generation/retries, not server inference measurements",
    durationMs: endedAt - startedAt, baseMs: baseReadyAt === undefined ? null : baseReadyAt - startedAt,
    startupMs: sessionAt === undefined ? null : sessionAt - startedAt,
    modelObservedMs: turns.reduce((sum, turn) => sum + turn.durationMs, 0),
    inputTokens: turns.reduce((sum, turn) => sum + turn.inputTokens, 0),
    outputTokens: turns.reduce((sum, turn) => sum + turn.outputTokens, 0),
    toolMs: Object.values(tools).reduce((sum, value) => sum + value.durationMs, 0),
    tools, turns, phaseMs, retryCount, compactionCount, pending };
}

/** Separate streams before correlating turn/tool IDs: different models often reuse them. */
export function summarizeAnalysisEvents(events: readonly Event[], startedAt: number, endedAt: number, baseReadyAt?: number) {
  const groups = new Map<string, Event[]>([["root", []]]);
  for (const event of events) {
    const id = typeof event["agentId"] === "string" ? event["agentId"] : "root";
    const group = groups.get(id) ?? [];
    group.push(event);
    groups.set(id, group);
  }
  const agents = Object.fromEntries([...groups].map(([id, group]) => {
    const first = group.find((event) => Number.isFinite(timestamp(event["at"])));
    const last = group.find((event) => event["type"] === "subagent_result");
    return [id, summarizeAgentEvents(group, id === "root" ? startedAt : timestamp(first?.["at"]) || startedAt,
      last ? timestamp(last["at"]) : endedAt, id === "root" ? baseReadyAt : undefined)];
  }));
  const root = agents["root"]!;
  const summaries = Object.values(agents);
  const sum = (key: "inputTokens" | "outputTokens" | "modelObservedMs" | "retryCount" | "compactionCount") =>
    summaries.reduce((total, entry) => total + entry[key], 0);
  const tools: typeof root.tools = {};
  const phaseMs: Record<string, number> = {};
  for (const entry of summaries) {
    for (const [name, value] of Object.entries(entry.tools)) {
      const merged = tools[name] ??= { calls: 0, errors: 0, durationMs: 0 };
      merged.calls += value.calls; merged.errors += value.errors; merged.durationMs += value.durationMs;
    }
    for (const [phase, ms] of Object.entries(entry.phaseMs)) phaseMs[phase] = (phaseMs[phase] ?? 0) + ms;
  }
  const validationEvents = events.filter((event) => event["type"] === "analysis_validation_failed");
  // Baseline workers recorded rejections only as tool errors; include their repair window too.
  const submissionFailures = events.filter((event) => event["type"] === "tool_result" && event["isError"] &&
    (event["agentId"] === undefined || event["agentId"] === "root") &&
    ["submit_analysis", "repair_analysis_group", "finalize_analysis"].includes(String(event["name"])));
  const acceptedEvent = events.findLast((event) => event["type"] === "analysis_accepted");
  const firstFailureAt = timestamp((validationEvents[0] ?? submissionFailures[0])?.["at"]);
  const validationCodes: Record<string, number> = {};
  for (const event of validationEvents) for (const issue of Array.isArray(event["issues"]) ? event["issues"].map(object) : []) {
    const code = String(issue["code"]); validationCodes[code] = (validationCodes[code] ?? 0) + 1;
  }
  return {
    ...root, schemaVersion: 2,
    validation: { failures: validationEvents.length || submissionFailures.length, codes: validationCodes,
      groupRepairs: events.filter((event) => event["type"] === "analysis_group_repair").length,
      repairMs: Number.isFinite(firstFailureAt) ? Math.max(0, (timestamp(acceptedEvent?.["at"]) || endedAt) - firstFailureAt) : 0,
      degraded: acceptedEvent?.["status"] === "degraded",
      exclusions: Array.isArray(acceptedEvent?.["exclusions"]) ? acceptedEvent["exclusions"].length : 0 },
    timingDefinition: "durationMs is wall time; modelObservedMs and toolMs sum per-agent client-observed intervals and may overlap. toolMs excludes subagent orchestration waits (delegationMs).",
    inputTokens: sum("inputTokens"), outputTokens: sum("outputTokens"), modelObservedMs: sum("modelObservedMs"),
    retryCount: sum("retryCount"), compactionCount: sum("compactionCount"),
    toolMs: Object.entries(tools).filter(([name]) => name !== "subagent").reduce((total, [, value]) => total + value.durationMs, 0),
    delegationMs: tools["subagent"]?.durationMs ?? 0,
    tools, phaseMs, agents,
    turns: Object.entries(agents).flatMap(([agentId, entry]) => entry.turns.map((turn) => ({ ...turn, agentId }))),
    pending: Object.entries(agents).flatMap(([agentId, entry]) => entry.pending.map((item) =>
      agentId === "root" ? item : { ...item, agentId })),
  };
}
