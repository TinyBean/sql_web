import { mkdirSync, readFileSync, writeFileSync, existsSync, createReadStream, chmodSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { DatabaseSync, backup } from "node:sqlite";
import { createHash } from "node:crypto";
import { loadDataCommandConfig } from "./database/data-command-config.ts";
import { assertDate } from "../src/server/database/business-dates.ts";
import { readAnalysisEvents, summarizeAnalysisEvents } from "../src/server/dashboard/default/analysis/metrics.ts";
import type { AppLogger } from "../src/server/logger.ts";

const { values } = parseArgs({ options: {
  "baseline-root": { type: "string" }, "candidate-root": { type: "string", default: process.cwd() },
  "output-dir": { type: "string" }, "through-date": { type: "string" },
  snapshot: { type: "string" }, pairs: { type: "string", default: "3" },
} });
if (!values["baseline-root"] || !values["output-dir"] || !values["through-date"]) {
  throw new Error("需要 --baseline-root、--output-dir、--through-date；可选 --snapshot 指向已有一致备份、--pairs（默认3）");
}
const pairs = Number(values.pairs);
if (!Number.isSafeInteger(pairs) || pairs < 1 || pairs > 10) throw new Error("pairs 必须为 1–10");
const throughDate = values["through-date"];
assertDate(throughDate);
const outputDir = path.resolve(values["output-dir"]);
const baselineRoot = path.resolve(values["baseline-root"]);
const candidateRoot = path.resolve(values["candidate-root"]);
if (baselineRoot === candidateRoot) throw new Error("新旧版本目录不能相同");
mkdirSync(outputDir, { recursive: true, mode: 0o700 });
if (existsSync(path.join(outputDir, "evaluation.json"))) throw new Error("评估目录已使用，请使用新目录");
const config = loadDataCommandConfig(candidateRoot);
const databasePath = values.snapshot ? path.resolve(values.snapshot) : path.join(outputDir, "database.sqlite");
if (!values.snapshot) {
  if (existsSync(databasePath)) throw new Error("备份目标已存在");
  const source = new DatabaseSync(config.databasePath, { readOnly: true });
  try { await backup(source, databasePath); } finally { source.close(); }
  chmodSync(databasePath, 0o600);
}
if (databasePath === path.resolve(config.databasePath)) throw new Error("必须使用数据库副本，不能直接评估生产数据库");
const databaseHash = createHash("sha256");
for await (const chunk of createReadStream(databasePath)) databaseHash.update(chunk as Buffer);
const databaseSha256 = databaseHash.digest("hex");
const common = { baselineRoot, candidateRoot, databasePath, databaseSha256, throughDate,
  provider: config.analysis.provider, model: config.analysis.model,
  contextWindow: config.analysis.contextWindow, maxOutputTokens: config.analysis.maxOutputTokens,
  timeoutMs: config.analysis.timeoutMs, pairs };
const results: { variant: string; pair: number; runId: string; status: string; reason: string | null;
  metrics: ReturnType<typeof summarizeAnalysisEvents> }[] = [];
const save = () => writeFileSync(path.join(outputDir, "evaluation.json"), JSON.stringify({ ...common, results }, null, 2), { mode: 0o600 });
save();
const logger: AppLogger = { info() {}, warn() {}, error() {}, child() { return this; } };
const now = new Date(); // Identical dashboard timestamps avoid irrelevant baseline diffs.
for (let pair = 1; pair <= pairs; pair += 1) {
  for (const variant of pair % 2 ? ["baseline", "candidate"] : ["candidate", "baseline"]) {
    const root = variant === "baseline" ? baselineRoot : candidateRoot;
    const { generateAnalyzedDashboard } = await import(pathToFileURL(path.join(root,
      "src/server/dashboard/default/analysis/run.ts")).href) as typeof import("../src/server/dashboard/default/analysis/run.ts");
    const runId = variant + "-" + pair;
    console.log(JSON.stringify({ event: "benchmark.started", runId, at: new Date().toISOString() }));
    const result = await generateAnalyzedDashboard({ databasePath, analysis: {
      ...config.analysis, cwd: root, artifactDir: path.join(outputDir, "runs"),
    } }, throughDate, now, [], logger, runId);
    const runDir = result.analysisArtifactDir;
    writeFileSync(path.join(runDir, "analyzed-dashboard.json"), JSON.stringify(result.state), { mode: 0o600 });
    const run = JSON.parse(readFileSync(path.join(runDir, "run.json"), "utf8")) as { startedAt: string; durationMs: number };
    const start = Date.parse(run.startedAt);
    const metrics = summarizeAnalysisEvents(readAnalysisEvents(path.join(runDir, "events.jsonl")), start, start + run.durationMs);
    writeFileSync(path.join(runDir, "evaluation-metrics.json"), JSON.stringify(metrics, null, 2), { mode: 0o600 });
    results.push({ variant, pair, runId, status: result.analysisStatus, reason: result.analysisReason, metrics });
    save();
    console.log(JSON.stringify({ event: "benchmark.completed", runId, status: result.analysisStatus,
      seconds: run.durationMs / 1000, outputTokens: metrics.outputTokens }));
  }
}
const median = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.length ? (sorted[Math.floor((sorted.length - 1) / 2)]! + sorted[Math.floor(sorted.length / 2)]!) / 2 : null;
};
const stats = (variant: string) => {
  const runs = results.filter((result) => result.variant === variant);
  const successful = runs.filter((result) => result.status === "completed");
  return { successful: successful.length, total: runs.length,
    medianMs: median(successful.map((result) => result.metrics.durationMs)),
    medianOutputTokens: median(successful.map((result) => result.metrics.outputTokens)),
    pythonCalls: runs.map((result) => result.metrics.tools["code_interpreter"]?.calls ?? 0),
    submissionErrors: runs.map((result) => (result.metrics.tools["submit_analysis"]?.errors ?? 0) +
      (result.metrics.tools["finalize_analysis"]?.errors ?? 0)) };
};
const baseline = stats("baseline"), candidate = stats("candidate");
const reduction = baseline.successful >= 2 && baseline.medianMs && candidate.medianMs ? 1 - candidate.medianMs / baseline.medianMs : null;
const summary = { baseline, candidate, successfulMedianReduction: reduction,
  performanceTargetMet: reduction !== null && reduction >= 0.2 && candidate.successful === pairs,
  qualityReview: "pending: audit report claims and recurring evidence-backed baseline priorities before acceptance" };
writeFileSync(path.join(outputDir, "summary.json"), JSON.stringify(summary, null, 2), { mode: 0o600 });
console.log(JSON.stringify(summary));
