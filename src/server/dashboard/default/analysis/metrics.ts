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
      const legacyPhase = names.includes("finalize_analysis") ? "review" : names.includes("submit_analysis")
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
  return {
    ...root, schemaVersion: 2,
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
