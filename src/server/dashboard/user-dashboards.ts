import { readFileSync } from "node:fs";
import { normalizeAccount } from "../auth.ts";
import type { DashboardRegistry } from "./index.ts";

export function loadUserDashboards(filePath: string, registry: DashboardRegistry): (account: string) => readonly string[] {
  const value: unknown = JSON.parse(readFileSync(filePath, "utf8"));
  if (!value || typeof value !== "object" || Array.isArray(value) || !("users" in value) ||
      !value.users || typeof value.users !== "object" || Array.isArray(value.users)) {
    throw new Error("账号看板配置必须包含 defaultDashboards 和 users 对象");
  }
  if (("defaultDashboards" in value) === ("defaultDashboard" in value)) {
    throw new Error("账号看板配置必须且只能包含 defaultDashboards 或旧 defaultDashboard");
  }
  const known = new Set(registry.list().map((item) => item.id));
  function ids(input: unknown, allowString = true): readonly string[] {
    const items: unknown[] = allowString && typeof input === "string" ? [input] : Array.isArray(input) ? input : [];
    if (!items.length) throw new Error("账号看板列表不能为空");
    const result: string[] = [];
    for (const id of items) {
      if (typeof id !== "string" || !known.has(id)) throw new Error("账号配置引用未知看板：" + String(id));
      if (result.includes(id)) throw new Error("账号看板配置存在重复看板：" + id);
      result.push(id);
    }
    return Object.freeze(result);
  }
  const defaults = "defaultDashboards" in value ? ids(value.defaultDashboards, false) :
    ids("defaultDashboard" in value ? value.defaultDashboard : undefined);
  const users = new Map<string, readonly string[]>();
  for (const [key, dashboards] of Object.entries(value.users)) {
    const account = normalizeAccount(key);
    if (users.has(account)) throw new Error("账号看板配置存在重复账号：" + account);
    users.set(account, ids(dashboards));
  }
  return (account) => users.get(normalizeAccount(account)) ?? defaults;
}
