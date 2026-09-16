import { readFileSync } from "node:fs";
import path from "node:path";
import { parseEnv } from "node:util";
import type { OeeDataStoreOptions } from "./oee-data-store.ts";

import type { DefaultDashboardAnalysisConfig } from "../../src/server/dashboard/default/config.ts";

export interface DataCommandConfig extends OeeDataStoreOptions {
  readonly defaultDashboardPath: string;
  readonly logDir: string;
  readonly analysis: DefaultDashboardAnalysisConfig;
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
  const tokenSetting = (name: string, fallback: number, minimum: number): number => {
    const value = Number(setting(name) ?? fallback);
    if (!Number.isSafeInteger(value) || value < minimum || value > 2_147_483_647) {
      throw new Error(name + " 必须是至少 " + minimum + " 的整数 token 数");
    }
    return value;
  };
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
      contextWindow: tokenSetting("SQL_WEB_DAILY_ANALYSIS_CONTEXT_WINDOW", 262144, 16384),
      maxOutputTokens: tokenSetting("SQL_WEB_DAILY_ANALYSIS_MAX_OUTPUT_TOKENS", 32768, 1024),
      codeInterpreter: {
        pythonPath: path.resolve(projectRoot, setting("SQL_WEB_PYTHON_PATH")?.trim() || "/usr/bin/python3"),
        bwrapPath: path.resolve(projectRoot, setting("SQL_WEB_BWRAP_PATH")?.trim() || "/usr/bin/bwrap"),
        prlimitPath: path.resolve(projectRoot, setting("SQL_WEB_PRLIMIT_PATH")?.trim() || "/usr/bin/prlimit"),
      },
    },
    ...(apiBaseUrl ? { apiBaseUrl } : {}),
    ...(apiUsername !== undefined ? { apiUsername } : {}),
    ...(apiPassword !== undefined ? { apiPassword } : {}),
  };
}
