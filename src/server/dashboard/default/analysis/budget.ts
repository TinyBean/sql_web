import type { DefaultDashboardAnalysisConfig } from "../config.ts";

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
