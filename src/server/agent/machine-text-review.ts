import type { InlineExtension, MessageEndEvent } from "@earendil-works/pi-coding-agent";
import { formatMachineMentions, hasMachineDistributionClaim } from "../skills/test-oee-calculator/assets/machine-platforms.ts";
import { RANK_MACHINES_TOOL_NAME, type MachineRankingScope } from "../skills/test-oee-calculator/assets/machine-ranking.ts";
import type { DatePeriod } from "../database/business-dates.ts";

export const MACHINE_TEXT_REVIEW_MESSAGE_TYPE = "sql_web.machine_text_review";
export interface RankingNarrative {
  readonly range: DatePeriod;
  readonly scope: MachineRankingScope;
  readonly summary: string;
  readonly top3: readonly { readonly machine: string }[];
}

function queryOnly(userText: string): boolean {
  const machines = [...new Set(userText.match(/(?:ADH|TSPH)\d{3}/gu) ?? [])];
  const analysis = /分析|问题|原因|改善|异常|偏低|集中|分散|排名|TOP\s*\d|对比|最低|最高/iu.test(userText);
  if (machines.length === 1 && !analysis) return true;
  return !machines.length && !analysis && /公式|定义|怎么算|计算方法|计算口径/iu.test(userText);
}

export function reviewMachineText(text: string, rankings: readonly RankingNarrative[], userText = "") {
  const normalized = formatMachineMentions(text, rankings.flatMap((ranking) => ranking.top3.map((row) => row.machine)));
  if (queryOnly(userText) && !hasMachineDistributionClaim(normalized)) return { text: normalized, requiresReview: false };
  const analysis = hasMachineDistributionClaim(normalized) ||
    /(?:OEE|Performance|Yield|可用率|良率|测试时间|Socket|损失).{0,25}(?:偏低|下降|异常|问题|改善|集中|分散)|(?:主要|最大)损失/iu.test(normalized);
  const numericalTop3 = /TOP\s*3/iu.test(normalized);
  if (rankings.length) {
    // Only server-authored summaries can authorize a TOP3 claim. Missing summaries are appended exactly.
    let residual = normalized;
    for (const ranking of rankings) residual = residual.replaceAll(ranking.summary, "");
    const unauthorizedTop3 = numericalTop3 && /TOP\s*3/iu.test(residual);
    if (unauthorizedTop3) return { text: normalized, requiresReview: true };
    const claims = residual.split(/[。！？\n]/u).filter((sentence) => hasMachineDistributionClaim(sentence) ||
      /偏低|下降|异常|主要损失|最大损失/iu.test(sentence));
    for (const claim of claims) {
      const kinds: readonly string[] = claim.match(/\b(?:MT|ST)\b/gu) ?? [];
      const states: readonly string[] = claim.match(/\b(?:Assistance|Conversion|HangUp|PM|IDLE(?:_[A-Za-z]+)?)\b/gu) ?? [];
      const metric = /Socket|DUT[- ]?On/iu.test(claim) ? "dut_on" : /Test\s*Time|测试时间/iu.test(claim) ? "test_time_performance" :
        /Yield|良率/iu.test(claim) ? "final_yield" : /损失|集中|分散/iu.test(claim) ? "loss_hours" : null;
      if (hasMachineDistributionClaim(claim) && rankings.every((ranking) => !ranking.top3.length)) {
        return { text: normalized, requiresReview: true };
      }
      if (!rankings.some((ranking) => (!kinds.length || kinds.includes(ranking.scope.kind)) &&
          (!metric || ranking.scope.metric === metric) && states.every((state) => ranking.scope.states.includes(state)))) {
        return { text: normalized, requiresReview: true };
      }
      if (kinds.some((kind) => !rankings.some((ranking) => ranking.scope.kind === kind && (!metric || ranking.scope.metric === metric)))) {
        return { text: normalized, requiresReview: true };
      }
    }
    const missing = rankings.map((ranking) => ranking.summary).filter((summary) => !normalized.includes(summary));
    return { text: [normalized, ...missing].join("\n\n"), requiresReview: false };
  }
  const unavailable = /(?:机台|排名|TOP\s*3).{0,20}(?:数据不足|无法|未核实)|(?:数据不足|没有数据|无可计算).{0,20}(?:机台|排名|TOP\s*3)/iu.test(normalized);
  return { text: normalized, requiresReview: hasMachineDistributionClaim(normalized) || ((analysis || numericalTop3) && !unavailable) };
}

function narrative(value: unknown): RankingNarrative | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Partial<RankingNarrative> & { truncated?: boolean };
  if (typeof row.summary !== "string" || !row.range || !row.scope || !Array.isArray(row.top3) ||
      row.truncated !== false || typeof row.range.start !== "string" || typeof row.range.end !== "string" ||
      !row.top3.every((entry) => entry && typeof entry.machine === "string")) return null;
  return row as RankingNarrative;
}

export function createMachineTextReviewExtension(logger: {
  info(event: string, fields?: Readonly<Record<string, unknown>>): void;
  warn(event: string, fields?: Readonly<Record<string, unknown>>): void;
}): InlineExtension {
  return { name: "sql-web-machine-text-review", hidden: true, factory: (pi) => {
    const rankings = new Map<string, RankingNarrative>();
    let userText = "";
    let attempted = false;
    let active = false;
    let repairCalls = 0;
    let pending = false;
    pi.on("message_end", (event, context) => {
      const message = event.message;
      if (message.role === "user") {
        rankings.clear(); attempted = false; active = false; repairCalls = 0; pending = false;
        userText = typeof message.content === "string" ? message.content :
          message.content.filter((part) => part.type === "text").map((part) => part.text).join("\n");
        return;
      }
      if (message.role === "toolResult") {
        if (message.toolName === RANK_MACHINES_TOOL_NAME && !message.isError) {
          const result = narrative(message.details);
          if (result) rankings.set(JSON.stringify([result.range, result.scope]), result);
        }
        return;
      }
      if (message.role !== "assistant" || !["stop", "length"].includes(message.stopReason) ||
          message.content.some((part) => part.type === "toolCall")) return;
      const original = message.content.filter((part) => part.type === "text").map((part) => part.text).join("\n");
      const result = reviewMachineText(original, [...rankings.values()], userText);
      let text = result.text;
      if (result.requiresReview && !attempted) pending = true;
      else if (result.requiresReview) {
        text = ["机台分布证据不足，无法给出未核实的机台排名或集中、分散结论。", ...[...rankings.values()].map((ranking) => ranking.summary)].join("\n\n");
        logger.warn("agent.machine_text_review.unavailable", { sessionId: context.sessionManager.getSessionId() });
      }
      if (active) active = false;
      logger.info("agent.machine_text_review.checked", { sessionId: context.sessionManager.getSessionId(),
        requiresReview: result.requiresReview, rankingCount: rankings.size });
      if (text === original) return;
      let replaced = false;
      const content = message.content.map((part) => {
        if (part.type !== "text") return part;
        const result = { ...part, text: replaced ? "" : text }; replaced = true; return result;
      });
      if (!replaced) content.push({ type: "text", text });
      return { message: { ...message, content } as MessageEndEvent["message"] };
    });
    pi.on("turn_end", () => {
      if (!pending) return;
      pending = false; attempted = true; active = true;
      pi.sendMessage({ customType: MACHINE_TEXT_REVIEW_MESSAGE_TYPE, display: false,
        content: "请修正上一条候选回答并输出完整回答。具体问题与机台分布必须用同范围同 MT/ST 的 test_oee_calculator__rank_machines 查证（尚未加载时先读取 OEE Skill），最多补查六次。TOP3 只逐字引用工具 summary，不能手写或猜测数值；纯公式解释、单台查询无需 TOP3。无法查证时明确说明机台分布数据不足并删除未核实的分布结论。不要执行发邮件、修改看板或委派任务等业务动作。" });
    });
    pi.on("tool_call", (event) => {
      if (!active) return;
      if ((event.toolName === RANK_MACHINES_TOOL_NAME && repairCalls++ < 6) || event.toolName === "read" || event.toolName === "get_current_time") return;
      return { block: true, reason: "机台描述修正阶段仅允许读取规则、查询时间及最多六次机台排名查询" };
    });
    pi.on("agent_settled", () => { active = false; pending = false; });
  } };
}
