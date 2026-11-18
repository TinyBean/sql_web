import path from "node:path";
import type { OeeDataStoreOptions } from "./oee-data-store.ts";
import { loadEmailConfig, readCommandEnvironment, resolveSharedPaths } from "../../src/server/config.ts";
import type { NotificationOptions } from "../../src/server/dashboard/email.ts";

import type { DefaultDashboardAnalysisConfig } from "../../src/server/dashboard/default/analysis/index.ts";

export interface DataCommandConfig extends OeeDataStoreOptions {
  readonly defaultDashboardPath: string;
  readonly logDir: string;
  readonly analysis: DefaultDashboardAnalysisConfig;
  readonly notificationOptions: NotificationOptions;
}

export function loadDataCommandConfig(
  projectRoot: string,
  environment: NodeJS.ProcessEnv = process.env,
): DataCommandConfig {
  const env = readCommandEnvironment(projectRoot, environment);
  const { databasePath, defaultDashboardPath, codeInterpreter } = resolveSharedPaths(env, projectRoot);
  const apiBaseUrl = env["OEE_API_BASE_URL"];
  const apiUsername = env["API_USER"];
  const apiPassword = env["API_PWD"];
  const timeoutMs = Number(env["SQL_WEB_DAILY_ANALYSIS_TIMEOUT_MS"] ?? "600000");
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2_147_483_647) {
    throw new Error("SQL_WEB_DAILY_ANALYSIS_TIMEOUT_MS 必须是有效的正整数毫秒数");
  }
  const tokenSetting = (name: string, fallback: number, minimum: number): number => {
    const value = Number(env[name] ?? fallback);
    if (!Number.isSafeInteger(value) || value < minimum || value > 2_147_483_647) {
      throw new Error(name + " 必须是至少 " + minimum + " 的整数 token 数");
    }
    return value;
  };
  return {
    databasePath,
    defaultDashboardPath,
    logDir: path.join(projectRoot, ".data", "logs"),
    notificationOptions: {
      configPath: path.join(projectRoot, ".data", "notifications.json"),
      loadEmail: () => loadEmailConfig(env),
    },
    analysis: {
      cwd: projectRoot,
      agentDir: path.join(projectRoot, ".data", "agent"),
      artifactDir: path.join(projectRoot, ".data", "daily-analysis"),
      provider: env.SQL_WEB_PROVIDER?.trim() ?? "",
      model: env.SQL_WEB_MODEL?.trim() ?? "",
      timeoutMs,
      contextWindow: tokenSetting("SQL_WEB_DAILY_ANALYSIS_CONTEXT_WINDOW", 262144, 16384),
      maxOutputTokens: tokenSetting("SQL_WEB_DAILY_ANALYSIS_MAX_OUTPUT_TOKENS", 32768, 1024),
      codeInterpreter,
    },
    ...(apiBaseUrl ? { apiBaseUrl } : {}),
    ...(apiUsername !== undefined ? { apiUsername } : {}),
    ...(apiPassword !== undefined ? { apiPassword } : {}),
  };
}
