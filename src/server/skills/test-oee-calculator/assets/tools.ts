import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { createRankMachinesTool } from "./machine-ranking.ts";
import type { TestOeeToolContext } from "./runtime.ts";
import {
  getDefaultTestOeeDashboardSql, getDefaultTestOeeSql,
  getMachinePeriodTestOeeSql, getTestOeeSqlExpressions,
} from "./test-oee-calculator.ts";

function jsonResult(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }], details: value };
}

const dateRangeParameters = {
  start_date: Type.String({ description: "开始业务日标签，YYYY-MM-DD。", pattern: "^\\d{4}-\\d{2}-\\d{2}$" }),
  end_date: Type.String({ description: "结束业务日标签，YYYY-MM-DD，包含整日。", pattern: "^\\d{4}-\\d{2}-\\d{2}$" }),
};

export function createTools(context?: TestOeeToolContext): ToolDefinition[] {
  const getDefaultSqlTool = defineTool({
    name: "get_default_sql",
    label: "获取全类型 Test OEE / Effective OEE SQL",
    description: "生成全类型日口径 SQL。view 默认 daily，返回逐日 MT/ST 明细及多日结果，数值为原始比率；overview 返回单行分类及合并概览，trends 返回 MT/ST 日趋势宽表，后两者的 _percent 列已乘 100。仅生成 SQL，再交给 execute_sql；看板查询需保存快照。公式见 Skill 业务规则，字段映射见 dashboard.md。",
    executionMode: "sequential",
    parameters: Type.Object({
      ...dateRangeParameters,
      view: Type.Optional(Type.Union([Type.Literal("daily"), Type.Literal("overview"), Type.Literal("trends")], {
        default: "daily", description: "daily 明细；overview 看板概览；trends 看板日趋势。",
      })),
    }, { additionalProperties: false }),
    async execute(_toolCallId, params, signal) {
      signal?.throwIfAborted();
      const view = params.view ?? "daily";
      const result = view === "daily"
        ? { ...getDefaultTestOeeSql(params.start_date, params.end_date), view, valueScale: "ratio" as const }
        : getDefaultTestOeeDashboardSql(params.start_date, params.end_date, view);
      signal?.throwIfAborted();
      return jsonResult(result);
    },
  });

  const getMachinePeriodSqlTool = defineTool({
    name: "get_machine_period_sql",
    label: "获取机台周期 Test OEE / Effective OEE SQL",
    description: "生成周期+机台+MT/ST 明细 SQL，grain 必填，支持 day/week/month/quarter。返回周期边界、部分周期标记、实际覆盖、组成项、截尾样本及封顶前后 Test Time；比率列以 1 表示 100%。仅生成 SQL，再交给 execute_sql；覆盖、周期聚合与空值规则见 Skill 业务规则。",
    executionMode: "sequential",
    parameters: Type.Object({
      ...dateRangeParameters,
      grain: Type.Union([Type.Literal("day"), Type.Literal("week"), Type.Literal("month"), Type.Literal("quarter")]),
    }, { additionalProperties: false }),
    async execute(_toolCallId, params, signal) {
      signal?.throwIfAborted();
      const result = getMachinePeriodTestOeeSql(params.start_date, params.end_date, params.grain);
      signal?.throwIfAborted();
      return jsonResult(result);
    },
  });

  const getSqlExpressionsTool = defineTool({
    name: "get_sql_expressions",
    label: "获取 OEE 自定义查询表达式",
    description: "返回指定来源的日期、基础 LOT 筛选、平台、类型及指标派生表达式，用于自定义 SQL 或通过 VALUES 抽查少量记录。sourceLotPredicate 用于基础 WHERE；DUT 的 yieldLotPredicate 仅用于 Yield 条件聚合。仅返回 SQL 片段，不执行查询；组合方法见 Skill 业务规则。",
    executionMode: "sequential",
    parameters: Type.Object({
      ...dateRangeParameters,
      source: Type.Union([Type.Literal("availability"), Type.Literal("dut")]),
      table_alias: Type.Optional(Type.String({
        description: "可选表别名，例如 a 或 d。", minLength: 1, maxLength: 64, pattern: "^[A-Za-z_][A-Za-z0-9_]*$",
      })),
    }, { additionalProperties: false }),
    async execute(_toolCallId, params, signal) {
      signal?.throwIfAborted();
      const result = getTestOeeSqlExpressions(params.source, params.start_date, params.end_date, params.table_alias);
      signal?.throwIfAborted();
      return jsonResult(result);
    },
  });

  return [getDefaultSqlTool, getMachinePeriodSqlTool, getSqlExpressionsTool, createRankMachinesTool(context?.runtime)];
}
