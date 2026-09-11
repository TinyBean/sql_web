import { defineTool } from "@earendil-works/pi-coding-agent";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  classifyAvailabilityStates,
  classifyTestOeeKinds,
  getDefaultTestOeeDashboardSql,
  getDefaultTestOeeSql,
  getTestOeeSqlExpressions,
  MAX_RULE_BATCH_SIZE,
  validateTestOeeLotIds,
} from "./test-oee-calculator.ts";

function jsonResult(value: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
    details: value,
  };
}

export function createTools(): ToolDefinition[] {
  const getDefaultSqlTool = defineTool({
    name: "get_default_sql",
    label: "获取默认 Test OEE SQL",
    description:
      "生成完整的默认 Test OEE SQLite 查询。查询排除平台名称包含 PCIe 的机台，在业务日+MT/ST 粒度分别汇总 Availability、DUT-On、0.2% 截尾 Test Time 和 Yield，以 Availability 为主左连接 DUT，四项相乘得到日 OEE，再等权平均日 OEE 得到多日结果。工具只返回 SQL，不连接数据库。",
    executionMode: "sequential",
    parameters: Type.Object({
      start_date: Type.String({
        description: "业务日闭区间的开始日，格式 YYYY-MM-DD；每个业务日为当天 08:30 至次日 08:30。",
        pattern: "^\\d{4}-\\d{2}-\\d{2}$",
      }),
      end_date: Type.String({
        description: "业务日闭区间的结束日，格式 YYYY-MM-DD。",
        pattern: "^\\d{4}-\\d{2}-\\d{2}$",
      }),
    }),
    async execute(_toolCallId, params, signal) {
      signal?.throwIfAborted();
      const result = getDefaultTestOeeSql(params.start_date, params.end_date);
      signal?.throwIfAborted();
      return jsonResult(result);
    },
  });

  const getDefaultDashboardSqlTool = defineTool({
    name: "get_default_dashboard_sql",
    label: "获取默认 Test OEE 看板 SQL",
    description:
      "生成默认 Test OEE 看板所需的确定性 SQLite 查询，直接复用标准逐日 SQL。overview 返回恰好一行的周期汇总和完整覆盖计数；trends 返回逐业务日的 MT/ST 宽表。所有以 _percent 结尾的列都是百分数值（percentage points，例如 56.65 表示 56.65%），可直接配合 Dashboard 的 % unit，禁止再次乘以 100。工具只返回 SQL，不连接数据库。",
    executionMode: "sequential",
    parameters: Type.Object({
      start_date: Type.String({
        description: "业务日闭区间的开始日，格式 YYYY-MM-DD。",
        pattern: "^\\d{4}-\\d{2}-\\d{2}$",
      }),
      end_date: Type.String({
        description: "业务日闭区间的结束日，格式 YYYY-MM-DD。",
        pattern: "^\\d{4}-\\d{2}-\\d{2}$",
      }),
      view: Type.Union([Type.Literal("overview"), Type.Literal("trends")], {
        description: "overview 用于单行概览组件；trends 用于四项指标及 OEE 的 MT/ST 日趋势。",
      }),
    }),
    async execute(_toolCallId, params, signal) {
      signal?.throwIfAborted();
      const result = getDefaultTestOeeDashboardSql(
        params.start_date,
        params.end_date,
        params.view,
      );
      signal?.throwIfAborted();
      return jsonResult(result);
    },
  });

  const getSqlExpressionsTool = defineTool({
    name: "get_sql_expressions",
    label: "获取 Test OEE SQL 规则",
    description:
      "返回 Test OEE 固定关键规则和闭区间业务日范围对应的 SQLite 表达式，供自定义 execute_sql 原样复用，包括 LOT、PCIe 平台排除、MT/ST、Availability 状态以及 DUT 的 TD_Label 和测试秒数。date 是 08:30 至次日 08:30 的业务日标签；工具不连接数据库，也不固定聚合方式或最终公式。",
    executionMode: "sequential",
    parameters: Type.Object({
      source: Type.Union([Type.Literal("availability"), Type.Literal("dut")], {
        description: "选择 oee_availability 或 oee_dut_utilization 对应的字段映射。",
      }),
      start_date: Type.String({
        description: "查询闭区间的开始业务日标签，格式 YYYY-MM-DD。",
        pattern: "^\\d{4}-\\d{2}-\\d{2}$",
      }),
      end_date: Type.String({
        description: "查询闭区间的结束业务日标签，格式 YYYY-MM-DD；返回的谓词会包含该完整业务日。",
        pattern: "^\\d{4}-\\d{2}-\\d{2}$",
      }),
      table_alias: Type.Optional(Type.String({
        description: "SQL 查询中使用的可选表别名，例如 a 或 d。",
        minLength: 1,
        maxLength: 64,
        pattern: "^[A-Za-z_][A-Za-z0-9_]*$",
      })),
    }),
    async execute(_toolCallId, params, signal) {
      signal?.throwIfAborted();
      const result = getTestOeeSqlExpressions(
        params.source,
        params.start_date,
        params.end_date,
        params.table_alias,
      );
      signal?.throwIfAborted();
      return jsonResult(result);
    },
  });

  const validateLotIdsTool = defineTool({
    name: "validate_lot_ids",
    label: "筛选 Test OEE 批次",
    description:
      "按固定 P/M/R/A/F/L 前缀规则判定少量 LOT_ID 是否符合 Test OEE 条件。大范围数据应使用 get_sql_expressions 返回的条件在 execute_sql 中筛选。",
    executionMode: "sequential",
    parameters: Type.Object({
      lot_ids: Type.Array(Type.String(), {
        description: "待判定的 LOT_ID 列表。",
        minItems: 1,
        maxItems: MAX_RULE_BATCH_SIZE,
      }),
    }),
    async execute(_toolCallId, params, signal) {
      signal?.throwIfAborted();
      const result = validateTestOeeLotIds(params.lot_ids);
      signal?.throwIfAborted();
      return jsonResult(result);
    },
  });

  const classifyMtStTool = defineTool({
    name: "classify_mt_st",
    label: "判定 Test OEE MT/ST",
    description:
      "按固定步骤优先级和平台回退规则判定少量记录的 MT/ST 类型，同时标明其机台是否因 PCIe 平台被排除。大范围数据应使用 get_sql_expressions 返回的 CASE 和平台条件在 execute_sql 中分类、筛选。",
    executionMode: "sequential",
    parameters: Type.Object({
      records: Type.Array(Type.Object({
        step: Type.String({ description: "Availability STEP 或 DUT STEP_ID。" }),
        machine_id: Type.String({
          description: "Availability TOOL_NAME 或 DUT MACHINE_ID。",
        }),
      }), {
        description: "待分类的记录。",
        minItems: 1,
        maxItems: MAX_RULE_BATCH_SIZE,
      }),
    }),
    async execute(_toolCallId, params, signal) {
      signal?.throwIfAborted();
      const result = classifyTestOeeKinds(params.records.map((record) => ({
        step: record.step,
        machineId: record.machine_id,
      })));
      signal?.throwIfAborted();
      return jsonResult(result);
    },
  });

  const classifyAvailabilityStatesTool = defineTool({
    name: "classify_availability_states",
    label: "判定 Availability 状态",
    description:
      "按固定 Machine_Running 规则判定少量 Availability 记录的派生状态。大范围数据应使用 get_sql_expressions 返回的 CASE 在 execute_sql 中分类。",
    executionMode: "sequential",
    parameters: Type.Object({
      records: Type.Array(Type.Object({
        final_state: Type.String({ description: "Availability FINAL_STATE。" }),
        lot_id: Type.String({ description: "Availability LOT_ID。" }),
      }), {
        description: "待分类的 Availability 记录。",
        minItems: 1,
        maxItems: MAX_RULE_BATCH_SIZE,
      }),
    }),
    async execute(_toolCallId, params, signal) {
      signal?.throwIfAborted();
      const result = classifyAvailabilityStates(params.records.map((record) => ({
        finalState: record.final_state,
        lotId: record.lot_id,
      })));
      signal?.throwIfAborted();
      return jsonResult(result);
    },
  });

  return [
    getDefaultSqlTool,
    getDefaultDashboardSqlTool,
    getSqlExpressionsTool,
    validateLotIdsTool,
    classifyMtStTool,
    classifyAvailabilityStatesTool,
  ];
}
