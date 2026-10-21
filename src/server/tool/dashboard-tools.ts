import { defineTool } from "@earendil-works/pi-coding-agent";
import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import { Type, type Static, type TSchema } from "typebox";
import { Value } from "typebox/value";
import {
  DASHBOARD_ID_PATTERN,
  MAX_DASHBOARD_SERIES,
  MAX_DASHBOARD_TABLE_COLUMNS,
  MAX_DASHBOARD_WIDGETS,
  type DashboardState,
} from "../../shared/dashboard.ts";
import {
  DashboardInputError,
  SessionDashboardStore,
  type DashboardCommand,
  type DashboardWidgetRequest,
} from "../agent/session-dashboard.ts";

export const DASHBOARD_AGENT_TOOL_NAMES = ["get_dashboard", "update_dashboard"] as const;

export interface DashboardUpdateDetails {
  readonly kind: "dashboard_update";
  readonly dashboardId: string;
  readonly dashboard: DashboardState;
}

interface DashboardSummaryDetails {
  readonly kind: "dashboard_summary";
  readonly dashboardId: string;
  readonly revision: number;
  readonly changedWidgetIds: readonly string[];
  readonly pointCount: number;
}

type DashboardToolDetails = DashboardUpdateDetails | DashboardSummaryDetails;

export function isDashboardUpdateDetails(value: unknown): value is DashboardUpdateDetails {
  return typeof value === "object" && value !== null &&
    "kind" in value && value.kind === "dashboard_update" && "dashboard" in value &&
    "dashboardId" in value && typeof value.dashboardId === "string";
}

const dashboardId = Type.String({ pattern: DASHBOARD_ID_PATTERN.source, description: "ID of a dashboard bound to this session." });

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
    precision: Type.Integer({ minimum: 0, maximum: 8,
      description: "Compatibility field; use 2. Display always keeps integers unchanged and rounds fractional values half away from zero to exactly two decimal places, regardless of this field.",
    }),
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
    encoding: Type.Object({
      value: columnName,
      label: Type.Optional(Type.String({
        minLength: 1,
        maxLength: 120,
        description: "Label above the primary value. Match the actual metric and period; do not assume seven days or OEE.",
      })),
      description: Type.Optional(Type.String({
        minLength: 1,
        maxLength: 240,
        description: "Short explanation below the primary value. Match the actual aggregation or comparison shown.",
      })),
      gauges: series,
    }),
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
const widgetIds = Type.Array(widgetId, { minItems: 1, maxItems: MAX_DASHBOARD_WIDGETS });
const updateParameters = Type.Object({
  dashboard_id: dashboardId,
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

export function createDashboardTools(dashboard: SessionDashboardStore, sessionId: string) {
  const getDashboard = defineTool({
    name: "get_dashboard",
    label: "读取会话看板",
    description:
      "Return dashboards bound to this session, their revisions, date ranges, and widget metadata. Omit dashboard_ids to read all dashboards. Set include_data=true to include complete widget data. Read the target dashboard before editing it.",
    promptSnippet: "读取当前会话多个看板的 revision、卡片摘要或完整数据",
    executionMode: "sequential",
    parameters: Type.Object({
      dashboard_ids: Type.Optional(Type.Array(dashboardId, { minItems: 1, uniqueItems: true })),
      include_data: Type.Optional(Type.Boolean()),
    }),
    async execute(_toolCallId, params, signal) {
      signal?.throwIfAborted();
      const states = dashboard.listOrPreview(sessionId);
      const ids = params.dashboard_ids ?? states.map((item) => item.id);
      if (!ids.length || new Set(ids).size !== ids.length) throw new DashboardInputError("看板 ID 列表必须非空且不重复");
      const summaries = ids.map((id) => {
        const item = states.find((item) => item.id === id);
        if (!item) throw new DashboardInputError("会话中不存在看板：" + id);
        const state = item.state;
        return {
          id, title: item.title, revision: state.revision, dateRange: state.dateRange, dataAsOf: state.dataAsOf,
          widgets: state.widgets.map((widget) => params.include_data ? widget : ({
            id: widget.id, kind: widget.kind, title: widget.title, size: widget.size,
            ...(widget.kind === "overview" ? {
              label: widget.encoding.label ?? widget.title,
              description: widget.encoding.description ?? widget.metricDefinition,
            } : {}), warnings: widget.warnings,
          })),
        };
      });
      dashboard.listOrInitialize(sessionId);
      return {
        content: [{ type: "text" as const, text: JSON.stringify({ dashboards: summaries }, null, 2) }],
        details: { kind: "dashboard_read", dashboardIds: ids },
      };
    },
  });

  const updateDashboard = defineTool({
    name: "update_dashboard",
    label: "更新指标看板",
    description:
      "Atomically update exactly one bound dashboard selected by required dashboard_id. Revisions and widget IDs are local to that dashboard. For multiple dashboards, call this tool sequentially for each target. For upsert, reference one complete session snapshot created by execute_sql.save_as or measure_loss and map snapshot columns into a controlled widget. Never copy database rows into this call and never provide ECharts options, HTML, functions, or styles. For an overview, set encoding.label and encoding.description to match its actual metric, period, and aggregation; never assume seven days or OEE. Use SQL or the standard loss query to aggregate and sort the snapshot first. format.unit is a suffix only and never rescales values: with %, the snapshot must contain percentage points such as 56.65, not ratio 0.5665. Use get_dashboard immediately before this tool and pass its revision as base_revision.",
    promptSnippet: "按 dashboard_id、快照名和列映射原子更新指定会话看板",
    executionMode: "sequential",
    parameters: updateParameters,
    async execute(_toolCallId, params, signal, onUpdate): Promise<AgentToolResult<DashboardToolDetails>> {
      signal?.throwIfAborted();
      const targetId = checked(dashboardId, params.dashboard_id, "dashboard_id");
      dashboard.loadOrPreview(sessionId, targetId);
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
        const existingSize = dashboard.loadOrPreview(sessionId, targetId).widgets.find(
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
      const result = dashboard.apply(sessionId, command, targetId);
      onUpdate?.({
        content: [{ type: "text", text: `看板已保存为 revision ${result.dashboard.revision}` }],
        details: { kind: "dashboard_update", dashboardId: targetId, dashboard: result.dashboard },
      });
      const summary: DashboardSummaryDetails = {
        kind: "dashboard_summary",
        dashboardId: targetId,
        revision: result.dashboard.revision,
        changedWidgetIds: result.changedWidgetIds,
        pointCount: result.pointCount,
      };
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            dashboardId: targetId,
            revision: summary.revision,
            changedWidgetIds: summary.changedWidgetIds,
            pointCount: summary.pointCount,
          }, null, 2),
        }],
        details: summary,
      };
    },
  });

  return [getDashboard, updateDashboard] as const;
}
