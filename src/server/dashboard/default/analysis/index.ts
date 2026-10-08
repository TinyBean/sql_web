import { appendFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { DashboardState, DashboardTableWidget } from "../../../../shared/dashboard.ts";
import { SessionArtifactStore } from "../../../tool/artifact-store.ts";
import type { DefaultDashboardAnalysisConfig } from "../config.ts";
import { readDailyOee, coverageWarnings } from "../data.ts";
import { dashboardPeriods, periodLabel, isPartialPeriod, ANALYSIS_PERIOD_KEYS, PERIOD_GRAINS } from "../periods.ts";
import { createAnalysisTemplate } from "../template.ts";
import { AnalysisEvidence } from "./evidence.ts";
import { applyAnalysisReport, type AnalysisPublication } from "./report.ts";

export function prepareAnalysisCards(
  database: DatabaseSync, throughDate: string, syncWarnings: readonly string[] = [],
): DashboardTableWidget[] {
  const periods = dashboardPeriods(throughDate);
  return ANALYSIS_PERIOD_KEYS.map((key) => {
    const period = periods[key];
    const template = createAnalysisTemplate(key);
    const periodText = period.start + " 至 " + period.end;
    const grain = PERIOD_GRAINS[key];
    const label = key === "day" ? period.end : periodLabel(key === "week" ? period.start : period.end, PERIOD_GRAINS[key]);
    const subtitle = key === "day" ? "最新业务日 · " + period.end : (key === "week" ? "最近完整周" : grain + "累计") + " · " + periodText;
    const warnings = [...syncWarnings, ...coverageWarnings(readDailyOee(database, period)),
      "本次分析暂不可用：尚未生成临时 Agent 报告", "责任人列为职能建议，需管理层确认后指派到人"];
    if (key !== "day" && key !== "week" && isPartialPeriod(period, PERIOD_GRAINS[key])) {
      warnings.push("本期为截至 " + throughDate + " 的部分" + grain + "，损失小时不可与完整周期直接对比");
    }
    return {
      ...template, title: template.title + "（" + label + "）",
      subtitle: subtitle + " · 临时 Agent 分析",
      metricDefinition: periodText + " 的" + template.metricDefinition, warnings,
    };
  });
}

/** The caller keeps the numeric cards' read transaction open until analysis completes. */
export async function analyzeCards(
  database: DatabaseSync, state: DashboardState, throughDate: string,
  config: DefaultDashboardAnalysisConfig, runDir: string, onResult: (state: DashboardState, quality: AnalysisPublication) => void,
  signal?: AbortSignal, deadline = Date.now() + config.timeoutMs,
): Promise<void> {
  const log = (name: string, event: unknown): void => {
    appendFileSync(path.join(runDir, name + ".jsonl"), JSON.stringify({ at: new Date().toISOString(), ...event as object }) + "\n", { mode: 0o600 });
  };
  const artifacts = new SessionArtifactStore(runDir, "analysis-data");
  const evidence = new AnalysisEvidence(database, (record) => log("evidence", record), artifacts);
  const context = evidence.context(state, throughDate);
  writeFileSync(path.join(runDir, "context.json"), JSON.stringify(context), { mode: 0o600 });
  // Load the model SDK only after the parent has a usable numeric dashboard.
  const { runAnalysisAgent } = await import("./agent.ts");
  await runAnalysisAgent(config, context, evidence, (event) => log("events", event), (result) => {
    writeFileSync(path.join(runDir, "report.json"), JSON.stringify(result.report, null, 2), { mode: 0o600 });
    const quality: AnalysisPublication = { status: result.status, exclusions: result.exclusions.map((entry) => ({
      period: entry.period, kind: entry.kind, priority: entry.priority, codes: [...new Set(entry.issues.map((issue) => issue.code))],
    })) };
    writeFileSync(path.join(runDir, "report-quality.json"), JSON.stringify(quality, null, 2), { mode: 0o600 });
    onResult(applyAnalysisReport(state, result), quality);
  }, signal, deadline);
}
