import { defineTool } from "@earendil-works/pi-coding-agent";
import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import { Type, type Static, type TSchema } from "typebox";
import { Value } from "typebox/value";
import {
  MAX_DASHBOARD_SERIES,
  MAX_DASHBOARD_TABLE_COLUMNS,
  type DashboardState,
} from "../../shared/dashboard.ts";
import {
  DashboardInputError,
  DashboardModule,
  type DashboardCommand,
  type DashboardWidgetRequest,
} from "./dashboard.ts";

export const DASHBOARD_AGENT_TOOL_NAMES = ["get_dashboard", "update_dashboard"] as const;

export interface DashboardUpdateDetails {
  readonly kind: "dashboard_update";
  readonly dashboard: DashboardState;
}

interface DashboardSummaryDetails {
  readonly kind: "dashboard_summary";
  readonly revision: number;
  readonly changedWidgetIds: readonly string[];
  readonly pointCount: number;
}

type DashboardToolDetails = DashboardUpdateDetails | DashboardSummaryDetails;

export function isDashboardUpdateDetails(value: unknown): value is DashboardUpdateDetails {
  return typeof value === "object" && value !== null &&
    "kind" in value && value.kind === "dashboard_update" && "dashboard" in value;
}

const widgetId = Type.String({
  description: "Stable semantic widget id. Reuse an existing id when replacing the same subject.",
  minLength: 1,
  maxLength: 64,
  pattern: "^[a-z][a-z0-9-]{0,63}$",
});
const columnName = Type.String({ minLength: 1, maxLength: 80 });
const series = Type.Array(Type.Object({
  name: Type.String({ minLength: 1, maxLength: 80 }),
  column: columnName,
}), { minItems: 1, maxItems: MAX_DASHBOARD_SERIES });
const commonWidgetProperties = {
  id: widgetId,
  title: Type.String({ minLength: 1, maxLength: 120 }),
  subtitle: Type.String({ maxLength: 240 }),
  size: Type.Optional(
    Type.Union([Type.Literal("small"), Type.Literal("medium"), Type.Literal("wide")], {
      description: "Optional for an existing widget; its current size is preserved when omitted.",
    }),
  ),
  format: Type.Object({
    unit: Type.String({
      maxLength: 24,
      description: "Display suffix only; it never rescales snapshot values. For unit %, provide percentage points (56.65 means 56.65%), not a 0-1 ratio.",
    }),
    precision: Type.Integer({ minimum: 0, maximum: 8 }),
  }),
  metric_definition: Type.String({ minLength: 1, maxLength: 1_000 }),
  warnings: Type.Array(Type.String({ minLength: 1, maxLength: 300 }), { maxItems: 20 }),
};
const widget = Type.Union([
  Type.Object({
    ...commonWidgetProperties,
    kind: Type.Literal("kpi"),
    encoding: Type.Object({
      value: columnName,
      comparison: Type.Union([columnName, Type.Null()]),
    }),
  }),
  Type.Object({
    ...commonWidgetProperties,
    kind: Type.Literal("overview"),
    encoding: Type.Object({ value: columnName, gauges: series }),
  }),
  Type.Object({
    ...commonWidgetProperties,
    kind: Type.Literal("line"),
    encoding: Type.Object({ category: columnName, series }),
  }),
  Type.Object({
    ...commonWidgetProperties,
    kind: Type.Union([Type.Literal("bar"), Type.Literal("stacked-bar")]),
    encoding: Type.Object({
      category: columnName,
      series,
      orientation: Type.Union([Type.Literal("horizontal"), Type.Literal("vertical")]),
    }),
  }),
  Type.Object({
    ...commonWidgetProperties,
    kind: Type.Literal("donut"),
    encoding: Type.Object({ category: columnName, value: columnName }),
  }),
  Type.Object({
    ...commonWidgetProperties,
    kind: Type.Literal("table"),
    encoding: Type.Object({
      columns: Type.Array(Type.Object({
        key: columnName,
        label: Type.String({ minLength: 1, maxLength: 80 }),
      }), { minItems: 1, maxItems: MAX_DASHBOARD_TABLE_COLUMNS }),
    }),
  }),
]);
const dateValue = Type.Union([
  Type.String({ pattern: "^\\d{4}-\\d{2}-\\d{2}$" }),
  Type.Null(),
]);
const dateRange = Type.Object({ start: dateValue, end: dateValue });
const revision = Type.Union([
  Type.Integer({ minimum: 0 }),
  Type.String({
    pattern: "^(0|[1-9][0-9]*)$",
    maxLength: 16,
    description: "A decimal revision string is accepted for OpenAI-compatible servers that stringify tool arguments.",
  }),
]);
const widgetIds = Type.Array(widgetId, { minItems: 1, maxItems: 12 });
const updateParameters = Type.Object({
  action: Type.Union([
    Type.Literal("upsert"),
    Type.Literal("remove"),
    Type.Literal("reorder"),
    Type.Literal("reset"),
  ]),
  base_revision: revision,
  snapshot: Type.Optional(Type.String({ minLength: 1, maxLength: 64 })),
  date_range: Type.Optional(Type.Union([
    dateRange,
    Type.String({
      minLength: 2,
      maxLength: 256,
      description: "JSON-encoded date range accepted when the model server stringifies nested objects.",
    }),
  ])),
  widget: Type.Optional(Type.Union([
    widget,
    Type.String({
      minLength: 2,
      maxLength: 16_384,
      description: "JSON-encoded widget accepted when the model server stringifies nested objects.",
    }),
  ])),
  widget_id: Type.Optional(widgetId),
  widget_ids: Type.Optional(Type.Union([
    widgetIds,
    Type.String({
      minLength: 2,
      maxLength: 1_024,
      description: "JSON-encoded widget id array accepted when the model server stringifies arrays.",
    }),
  ])),
}, {
  description: "Fields not used by the selected action may be omitted.",
});

type WidgetInput = Static<typeof widget>;

function required(value: unknown, name: string): unknown {
  if (value === undefined) throw new DashboardInputError(`update_dashboard 缺少参数 ${name}`);
  return value;
}

function decodedJson(value: unknown, name: string): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    throw new DashboardInputError(`${name} 必须是原生 JSON 值或合法的 JSON 字符串`);
  }
}

function checked<Schema extends TSchema>(schema: Schema, value: unknown, name: string): Static<Schema> {
  if (Value.Check(schema, value)) return value as Static<Schema>;
  const first = [...Value.Errors(schema, value)][0];
  const detail = first
    ? `${first.instancePath || name} ${first.message}`
    : `${name} 结构无效`;
  throw new DashboardInputError(detail);
}

function baseRevision(value: string | number): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new DashboardInputError("base_revision 必须是非负安全整数");
  }
  return parsed;
}

function defaultWidgetSize(kind: WidgetInput["kind"]): "small" | "medium" | "wide" {
  if (kind === "kpi") return "small";
  if (kind === "overview") return "wide";
  if (kind === "line") return "wide";
  return "medium";
}

function widgetRequest(value: {
  readonly id: string;
  readonly kind: "kpi" | "overview" | "line" | "bar" | "stacked-bar" | "donut" | "table";
  readonly title: string;
  readonly subtitle: string;
  readonly size?: "small" | "medium" | "wide";
  readonly encoding: DashboardWidgetRequest["encoding"];
  readonly format: { readonly unit: string; readonly precision: number };
  readonly metric_definition: string;
  readonly warnings: readonly string[];
}, existingSize?: "small" | "medium" | "wide"): DashboardWidgetRequest {
  return {
    id: value.id,
    kind: value.kind,
    title: value.title,
    subtitle: value.subtitle,
    size: value.size ?? existingSize ?? defaultWidgetSize(value.kind),
    encoding: value.encoding,
    format: value.format,
    metricDefinition: value.metric_definition,
    warnings: value.warnings,
  } as DashboardWidgetRequest;
}

export function createDashboardTools(dashboard: DashboardModule, sessionId: string) {
  const getDashboard = defineTool({
    name: "get_dashboard",
    label: "读取当前看板",
    description:
      "Return the current dashboard revision, date range, and compact widget metadata. Call this before changing a dashboard. It intentionally omits chart rows.",
    promptSnippet: "读取当前会话的看板 revision 和组件摘要",
    executionMode: "sequential",
    parameters: Type.Object({}),
    async execute(_toolCallId, _params, signal): Promise<AgentToolResult<DashboardSummaryDetails>> {
      signal?.throwIfAborted();
      const state = dashboard.loadOrInitialize(sessionId);
      const summary = {
        revision: state.revision,
        dateRange: state.dateRange,
        dataAsOf: state.dataAsOf,
        widgets: state.widgets.map((item) => ({
          id: item.id,
          kind: item.kind,
          title: item.title,
          size: item.size,
          warnings: item.warnings,
        })),
      };
      return {
        content: [{ type: "text", text: JSON.stringify(summary, null, 2) }],
        details: {
          kind: "dashboard_summary",
          revision: state.revision,
          changedWidgetIds: [],
          pointCount: 0,
        },
      };
    },
  });

  const updateDashboard = defineTool({
    name: "update_dashboard",
    label: "更新指标看板",
    description:
      "Atomically update the current session dashboard. For upsert, reference one complete session snapshot created by execute_sql.save_as and map snapshot columns into a controlled widget. Never copy database rows into this call and never provide ECharts options, HTML, functions, or styles. SQL must aggregate and sort the snapshot first. format.unit is a suffix only and never rescales values: with %, the snapshot must contain percentage points such as 56.65, not ratio 0.5665. Use get_dashboard immediately before this tool and pass its revision as base_revision.",
    promptSnippet: "按快照名和列映射原子更新当前会话看板",
    executionMode: "sequential",
    parameters: updateParameters,
    async execute(_toolCallId, params, signal, onUpdate): Promise<AgentToolResult<DashboardToolDetails>> {
      signal?.throwIfAborted();
      const revisionNumber = baseRevision(params.base_revision);
      let command: DashboardCommand;
      if (params.action === "upsert") {
        const snapshot = required(params.snapshot, "snapshot");
        const decodedRange = checked(
          dateRange,
          decodedJson(required(params.date_range, "date_range"), "date_range"),
          "date_range",
        );
        const decodedWidget = checked(
          widget,
          decodedJson(required(params.widget, "widget"), "widget"),
          "widget",
        );
        const existingSize = dashboard.loadOrInitialize(sessionId).widgets.find(
          (item) => item.id === decodedWidget.id,
        )?.size;
        command = {
          action: "upsert",
          baseRevision: revisionNumber,
          snapshot: checked(Type.String({ minLength: 1, maxLength: 64 }), snapshot, "snapshot"),
          dateRange: decodedRange,
          widget: widgetRequest(decodedWidget, existingSize),
        };
      } else if (params.action === "remove") {
        command = {
          action: "remove",
          baseRevision: revisionNumber,
          widgetId: checked(widgetId, required(params.widget_id, "widget_id"), "widget_id"),
        };
      } else if (params.action === "reorder") {
        command = {
          action: "reorder",
          baseRevision: revisionNumber,
          widgetIds: checked(
            widgetIds,
            decodedJson(required(params.widget_ids, "widget_ids"), "widget_ids"),
            "widget_ids",
          ),
        };
      } else {
        command = { action: "reset", baseRevision: revisionNumber };
      }
      const result = dashboard.apply(sessionId, command);
      onUpdate?.({
        content: [{ type: "text", text: `看板已保存为 revision ${result.dashboard.revision}` }],
        details: { kind: "dashboard_update", dashboard: result.dashboard },
      });
      const summary: DashboardSummaryDetails = {
        kind: "dashboard_summary",
        revision: result.dashboard.revision,
        changedWidgetIds: result.changedWidgetIds,
        pointCount: result.pointCount,
      };
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            revision: summary.revision,
            changedWidgetIds: summary.changedWidgetIds,
            pointCount: summary.pointCount,
          }, null, 2),
        }],
        details: summary,
      };
    },
  });

  return [getDashboard, updateDashboard];
}
