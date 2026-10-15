import type { TSchema } from "typebox";
import { Value } from "typebox/value";
import { ANALYSIS_PERIOD_KEYS, type PeriodKey } from "../periods.ts";
import type { AnalysisValidationIssue } from "./report.ts";

export const MAX_STRUCTURE_ISSUES = 8;
export const pointerToken = (value: string): string => value.replaceAll("~", "~0").replaceAll("/", "~1");

export function pointerValue(value: unknown, path: string): unknown {
  if (!path || path === "#") return value;
  for (const token of path.replace(/^#/u, "").slice(1).split("/")) {
    const key = token.replaceAll("~1", "/").replaceAll("~0", "~");
    if (!value || typeof value !== "object" || !Object.hasOwn(value, key)) return undefined;
    value = (value as Record<string, unknown>)[key];
  }
  return value;
}

/** Diagnostics expose the offending scalar or shape, never a report or database row. */
export function diagnosticValue(value: unknown): unknown {
  if (value === undefined) return { type: "missing" };
  if (typeof value === "number" && !Number.isFinite(value)) return { type: "number", value: String(value) };
  if (typeof value === "string") return value.length > 160 ? value.slice(0, 160) + "…" : value;
  if (Array.isArray(value)) return { type: "array", length: value.length };
  if (value && typeof value === "object") return { type: "object", keys: Object.keys(value).slice(0, 12) };
  return value;
}

export function structureLocation(input: unknown, path: string): Pick<AnalysisValidationIssue, "period" | "kind" | "item_index" | "priority"> {
  const periodPath = path.match(/^\/periods\/\d+/u)?.[0];
  const groupPath = path.match(/^\/periods\/\d+\/groups\/\d+/u)?.[0] ?? (path.startsWith("/group/") ? "/group" : undefined);
  const itemPath = path.match(/^(?:\/periods\/\d+\/groups\/\d+|\/group)\/items\/(\d+)/u);
  const period = pointerValue(input, periodPath ? periodPath + "/period" : "/period");
  const kind = pointerValue(input, periodPath && groupPath ? groupPath + "/kind" : "/kind");
  const priority = itemPath ? pointerValue(input, itemPath[0] + "/priority") : undefined;
  return {
    ...(ANALYSIS_PERIOD_KEYS.includes(period as PeriodKey) ? { period: period as PeriodKey } : {}),
    ...(kind === "MT" || kind === "ST" ? { kind } : {}),
    ...(itemPath ? { item_index: Number(itemPath[1]) } : {}),
    ...(typeof priority === "number" && Number.isInteger(priority) ? { priority } : {}),
  };
}

/** Expand required/extra properties into precise JSON Pointers and bound independent errors. */
export function structureIssues(schema: TSchema, input: unknown): { issues: AnalysisValidationIssue[]; has_more: boolean } {
  const issues: AnalysisValidationIssue[] = [];
  const seen = new Set<string>();
  for (const error of Value.Errors(schema, input)) {
    // TypeBox reports each failed literal branch before the union error. Reporting a
    // single branch would incorrectly tell the model to replace every invalid period with day.
    const unionPath = error.schemaPath.match(/^(.*)\/anyOf\/\d+(?:\/.*)?$/u)?.[1];
    const union = unionPath === undefined ? undefined : pointerValue(schema, unionPath) as Record<string, unknown> | undefined;
    if (Array.isArray(union?.["anyOf"]) && union["anyOf"].every((entry: Record<string, unknown>) => Object.hasOwn(entry, "const"))) continue;
    const params = error.params as Record<string, unknown>;
    const definition = pointerValue(schema, error.schemaPath) as Record<string, unknown> | undefined;
    const names = error.keyword === "required" ? params["requiredProperties"] :
      error.keyword === "additionalProperties" ? params["additionalProperties"] : undefined;
    for (const name of Array.isArray(names) ? names : [undefined]) {
      const path = error.instancePath + (typeof name === "string" ? "/" + pointerToken(name) : "");
      const key = error.keyword + ":" + path;
      if (seen.has(key)) continue;
      seen.add(key);
      if (issues.length === MAX_STRUCTURE_ISSUES) return { issues, has_more: true };
      const field = error.keyword === "required" && typeof name === "string"
        ? (definition?.["properties"] as Record<string, Record<string, unknown>> | undefined)?.[name] : definition;
      const constraints = Object.fromEntries(Object.entries(field ?? {}).filter(([key]) =>
        ["type", "const", "enum", "minimum", "maximum", "minItems", "maxItems", "minLength"].includes(key)));
      if (Array.isArray(field?.["anyOf"])) constraints["enum"] = field["anyOf"].flatMap((entry: Record<string, unknown>) =>
        Object.hasOwn(entry, "const") ? [entry["const"]] : []);
      const expected = error.keyword === "additionalProperties" ? { allowed_fields: Object.keys((definition?.["properties"] as object | undefined) ?? {}) }
        : constraints;
      const rule = error.keyword === "required" ? "缺少必填字段" : error.keyword === "additionalProperties" ? "存在未定义字段，请删除此字段"
        : error.keyword === "const" || error.keyword === "anyOf" || error.keyword === "enum" ? "字段值不在允许范围内"
          : ["minItems", "maxItems"].includes(error.keyword) ? "数组项数不符合限制"
            : ["minimum", "maximum"].includes(error.keyword) ? "数字超出允许范围" : "字段类型或内容不符合要求";
      issues.push({ code: "STRUCTURE_INVALID", path: path || "/", ...structureLocation(input, path),
        reason: error.keyword, expected, actual: diagnosticValue(pointerValue(input, path)),
        message: "字段或结构无效：" + rule,
        hint: rule + "；按 expected 修正该字段，保留其他内容。数组下标 item_index、优先级 priority、证据原始行号 row_index 含义不同。" });
    }
  }
  return { issues, has_more: false };
}
