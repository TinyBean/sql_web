import { existsSync, readFileSync } from "node:fs";

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
export function summarizeAnalysisEvents(events: readonly Event[], startedAt: number, endedAt: number, baseReadyAt?: number) {
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
    else if (type === "auto_retry_start") retryCount += 1;
    else if (type === "compaction_start") compactionCount += 1;
    else if (type === "assistant") {
      const message = object(event["message"]);
      const usage = object(message["usage"]);
      const parts = Array.isArray(message["content"]) ? message["content"].map(object) : [];
      const names = parts.filter((part) => part["type"] === "toolCall").map((part) => part["name"]);
      if (Number(usage["output"] ?? 0) || Number(usage["input"] ?? 0) || parts.length || message["stopReason"] === "error") {
        turns.push({ turnId: Number(event["turnId"] ?? turns.length + 1),
          phase: names.includes("finalize_analysis") ? "review" : names.includes("submit_analysis") ? (draft ? "review" : "draft") : draft ? "review_investigation" : "investigation",
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
