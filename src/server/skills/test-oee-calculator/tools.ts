import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { AppDatabase } from "../../data/database.ts";
import {
  calculateTestOee,
  classifyTestOeeRecord,
  type TestOeeKindFilter,
} from "./test-oee-calculator.ts";

export function createTools({ database }: { readonly database: AppDatabase }) {
  const calculateTestOeeTool = defineTool({
    name: "calculate_test_oee",
    label: "计算 Test OEE",
    description:
      "Authoritative deterministic Test OEE calculator. Use it for every Test OEE, Availability, DUT-On, or Yield request instead of recreating classification or formulas in SQL. It applies the fixed valid-LOT, MT/ST, platform fallback, Machine_Running, all-machine Availability, all-stage Yield, and shared inclusive date-range rules.",
    executionMode: "sequential",
    parameters: Type.Object({
      start_date: Type.String({
        description: "Inclusive start date in YYYY-MM-DD format.",
        pattern: "^\\d{4}-\\d{2}-\\d{2}$",
      }),
      end_date: Type.String({
        description: "Inclusive end date in YYYY-MM-DD format.",
        pattern: "^\\d{4}-\\d{2}-\\d{2}$",
      }),
      kind: Type.Optional(
        Type.Union([Type.Literal("all"), Type.Literal("MT"), Type.Literal("ST")], {
          description: "Return both MT and ST (default), or only the selected kind.",
        }),
      ),
    }),
    async execute(_toolCallId, params, signal) {
      signal?.throwIfAborted();
      const result = calculateTestOee(
        database,
        params.start_date,
        params.end_date,
        (params.kind ?? "all") as TestOeeKindFilter,
      );
      signal?.throwIfAborted();
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
        details: result,
      };
    },
  });

  const classifyTestOeeRecordTool = defineTool({
    name: "classify_test_oee_record",
    label: "判定 Test OEE 记录",
    description:
      "Deterministically classify one source record for Test OEE. Use it instead of reasoning manually about eligible LOT_ID, MT/ST step precedence, platform fallback, or Machine_Running state.",
    executionMode: "sequential",
    parameters: Type.Object({
      lot_id: Type.String({ description: "Source LOT_ID." }),
      step: Type.String({ description: "Availability STEP or DUT STEP_ID." }),
      machine_id: Type.String({ description: "Availability TOOL_NAME or DUT MACHINE_ID." }),
      final_state: Type.Optional(
        Type.String({ description: "Availability FINAL_STATE when state classification is needed." }),
      ),
    }),
    async execute(_toolCallId, params, signal) {
      signal?.throwIfAborted();
      const result = classifyTestOeeRecord({
        lotId: params.lot_id,
        step: params.step,
        machineId: params.machine_id,
        ...(params.final_state === undefined ? {} : { finalState: params.final_state }),
      });
      signal?.throwIfAborted();
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
        details: result,
      };
    },
  });

  return [calculateTestOeeTool, classifyTestOeeRecordTool];
}
