import type { DefaultDashboardAnalysisConfig } from "../config.ts";

export const MAX_ANALYSIS_TOOL_CALLS = 60;
export const ANALYSIS_PARENT_TOOL_RESERVE = 8;

/** All agents acquire a slot synchronously, before SDK argument validation. */
export class AnalysisToolCallBudget {
  #used = 0;
  get used(): number { return this.#used; }
  get remainingForChildren(): number { return Math.max(0, MAX_ANALYSIS_TOOL_CALLS - ANALYSIS_PARENT_TOOL_RESERVE - this.#used); }
  take(child = false): boolean {
    if (this.#used >= MAX_ANALYSIS_TOOL_CALLS - (child ? ANALYSIS_PARENT_TOOL_RESERVE : 0)) return false;
    this.#used += 1;
    return true;
  }
}

export function analysisBudget(
  model: { readonly contextWindow: number; readonly maxTokens: number },
  config: Pick<DefaultDashboardAnalysisConfig, "contextWindow" | "maxOutputTokens">,
) {
  // The deployment limit can be lower than the model catalogue's advertised window.
  const contextWindow = Math.min(model.contextWindow, config.contextWindow);
  const maxTokens = Math.min(model.maxTokens, config.maxOutputTokens, Math.floor(contextWindow / 4));
  // Reserve output plus room for instructions, tool schemas, and the evidence index.
  const reserveTokens = Math.min(Math.floor(contextWindow / 2), maxTokens + 32768);
  return {
    contextWindow, maxTokens,
    compaction: { enabled: true, reserveTokens, keepRecentTokens: Math.min(16384, Math.floor(contextWindow / 8)) },
  };
}
