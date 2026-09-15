import { readFileSync } from "node:fs";
import path from "node:path";
import { parseEnv } from "node:util";
import type { OeeDataStoreOptions } from "./oee-data-store.ts";

export interface DataCommandConfig extends OeeDataStoreOptions {
  readonly defaultDashboardPath: string;
  readonly logDir: string;
  readonly analysis: {
    readonly cwd: string;
    readonly agentDir: string;
    readonly artifactDir: string;
    readonly provider: string;
    readonly model: string;
    readonly timeoutMs: number;
  };
}

export function loadDataCommandConfig(
  projectRoot: string,
  environment: NodeJS.ProcessEnv = process.env,
): DataCommandConfig {
  let fileEnvironment: Record<string, string | undefined> = {};
  try {
    fileEnvironment = parseEnv(readFileSync(path.join(projectRoot, ".env"), "utf8"));
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
  }
  const setting = (name: string): string | undefined => environment[name] ?? fileEnvironment[name];
  const apiBaseUrl = setting("OEE_API_BASE_URL");
  const apiUsername = setting("API_USER");
  const apiPassword = setting("API_PWD");
  const timeoutMs = Number(setting("SQL_WEB_DAILY_ANALYSIS_TIMEOUT_MS") ?? "600000");
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2_147_483_647) {
    throw new Error("SQL_WEB_DAILY_ANALYSIS_TIMEOUT_MS 必须是有效的正整数毫秒数");
  }
  return {
    databasePath: path.resolve(projectRoot, setting("SQL_WEB_DB_PATH") ?? ".data/database/oee.sqlite"),
    defaultDashboardPath: path.resolve(projectRoot, setting("SQL_WEB_DEFAULT_DASHBOARD_PATH") ?? ".data/default-dashboard.json"),
    logDir: path.join(projectRoot, ".data", "logs"),
    analysis: {
      cwd: projectRoot,
      agentDir: path.join(projectRoot, ".data", "agent"),
      artifactDir: path.join(projectRoot, ".data", "daily-analysis"),
      provider: setting("SQL_WEB_PROVIDER")?.trim() ?? "",
      model: setting("SQL_WEB_MODEL")?.trim() ?? "",
      timeoutMs,
    },
    ...(apiBaseUrl ? { apiBaseUrl } : {}),
    ...(apiUsername !== undefined ? { apiUsername } : {}),
    ...(apiPassword !== undefined ? { apiPassword } : {}),
  };
}
