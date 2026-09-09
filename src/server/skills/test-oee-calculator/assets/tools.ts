import { defineTool } from "@earendil-works/pi-coding-agent";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  classifyAvailabilityStates,
  classifyTestOeeKinds,
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
  const getSqlExpressionsTool = defineTool({
    name: "get_sql_expressions",
    label: "获取 Test OEE SQL 规则",
    description:
      "返回 Test OEE 固定关键规则和闭区间日期范围对应的 SQLite 表达式，供 execute_sql 原样复用。日期谓词兼容 date 字段中的 ISO 时间戳并包含 end_date 全天；工具不连接或查询数据库，也不固定聚合方式或最终公式。",
    executionMode: "sequential",
    parameters: Type.Object({
      source: Type.Union([Type.Literal("availability"), Type.Literal("dut")], {
        description: "选择 oee_availability 或 oee_dut_utilization 对应的字段映射。",
      }),
      start_date: Type.String({
        description: "查询闭区间的开始自然日，格式 YYYY-MM-DD。",
        pattern: "^\\d{4}-\\d{2}-\\d{2}$",
      }),
      end_date: Type.String({
        description: "查询闭区间的结束自然日，格式 YYYY-MM-DD；返回的谓词会包含该日全天。",
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
      "按固定步骤优先级和平台回退规则判定少量记录的 MT/ST 类型。大范围数据应使用 get_sql_expressions 返回的 CASE 在 execute_sql 中分类。",
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
    getSqlExpressionsTool,
    validateLotIdsTool,
    classifyMtStTool,
    classifyAvailabilityStatesTool,
  ];
}
