import { readFileSync } from "node:fs";
import { normalizeAccount } from "../auth.ts";
import type { DashboardRegistry } from "./index.ts";

export function loadUserDashboards(filePath: string, registry: DashboardRegistry): (account: string) => string {
  const value: unknown = JSON.parse(readFileSync(filePath, "utf8"));
  if (!value || typeof value !== "object" || !("defaultDashboard" in value) || !("users" in value) ||
      typeof value.defaultDashboard !== "string" || !value.users || typeof value.users !== "object" || Array.isArray(value.users)) {
    throw new Error("账号看板配置必须包含 defaultDashboard 和 users 对象");
  }
  const known = new Set(registry.list().map((item) => item.id));
  const defaultDashboard = value.defaultDashboard;
  if (!known.has(defaultDashboard)) throw new Error("账号配置引用未知看板：" + defaultDashboard);
  const users = new Map<string, string>();
  for (const [key, id] of Object.entries(value.users)) {
    const account = normalizeAccount(key);
    if (users.has(account)) throw new Error("账号看板配置存在重复账号：" + account);
    if (typeof id !== "string" || !known.has(id)) throw new Error("账号配置引用未知看板：" + String(id));
    users.set(account, id);
  }
  return (account) => users.get(normalizeAccount(account)) ?? defaultDashboard;
}
