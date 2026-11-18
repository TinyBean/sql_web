import { readFileSync } from "node:fs";
import path from "node:path";
import { parseEnv } from "node:util";
import { fileURLToPath } from "node:url";
import type { ModelSelection } from "../shared/contracts.ts";
import { validateEmailConfig, type EmailConfig } from "./dashboard/email.ts";
import { DEFAULT_DOMAIN_VERIFY_URL } from "./auth.ts";

const webEnvironmentKeys = [
  "HOST", "PORT", "SQL_WEB_DOMAIN_VERIFY_URL", "SQL_WEB_AUTH_COOKIE_SECURE",
  "SQL_WEB_USER_DASHBOARDS_PATH", "SQL_WEB_DB_PATH", "SQL_WEB_SESSION_DIR", "SQL_WEB_ARTIFACT_DIR",
  "SQL_WEB_QUERY_TIMEOUT_MS", "SQL_WEB_DEFAULT_DASHBOARD_PATH", "SQL_WEB_PYTHON_PATH", "SQL_WEB_BWRAP_PATH", "SQL_WEB_PRLIMIT_PATH",
  "SQL_WEB_PROVIDER", "SQL_WEB_MODEL", "SQL_WEB_SMTP_HOST", "SQL_WEB_SMTP_PORT",
  "SQL_WEB_MAIL_FROM_ADDRESS", "SQL_WEB_MAIL_FROM_NAME",
] as const;

export type AppEnvironment = { readonly [K in typeof webEnvironmentKeys[number]]?: string | undefined };

export interface AppConfig {
  readonly domainVerifyUrl: string;
  readonly authCookieSecure: boolean;
  readonly userDashboardsPath: string;
  readonly projectRoot: string;
  readonly host: string;
  readonly port: number;
  readonly databasePath: string;
  readonly queryTimeoutMs: number;
  readonly sessionDir: string;
  readonly artifactDir: string;
  readonly defaultDashboardPath: string;
  readonly publicDir: string;
  readonly agentDir: string;
  readonly logDir: string;
  readonly model: ModelSelection;
  readonly email: EmailConfig | null;
  readonly codeInterpreter: {
    readonly pythonPath: string;
    readonly bwrapPath: string;
    readonly prlimitPath: string;
  };
}

const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
const sourceRoot = path.resolve(moduleDirectory, "../..");
export const PROJECT_ROOT = path.basename(sourceRoot) === "dist"
  ? path.resolve(sourceRoot, "..")
  : sourceRoot;

export function resolveSessionDirectory(env: AppEnvironment, projectRoot: string): string {
  return path.resolve(projectRoot, env.SQL_WEB_SESSION_DIR ?? ".data/sessions");
}

export function resolveSharedPaths(env: AppEnvironment, projectRoot: string) {
  return {
    databasePath: path.resolve(projectRoot, env.SQL_WEB_DB_PATH ?? ".data/database/oee.sqlite"),
    defaultDashboardPath: path.resolve(projectRoot, env.SQL_WEB_DEFAULT_DASHBOARD_PATH ?? ".data/default-dashboard.json"),
    codeInterpreter: {
      pythonPath: path.resolve(projectRoot, env.SQL_WEB_PYTHON_PATH?.trim() || ".venv/bin/python"),
      bwrapPath: path.resolve(projectRoot, env.SQL_WEB_BWRAP_PATH?.trim() || "/usr/bin/bwrap"),
      prlimitPath: path.resolve(projectRoot, env.SQL_WEB_PRLIMIT_PATH?.trim() || "/usr/bin/prlimit"),
    },
  };
}

function parsePort(value: string | undefined): number {
  const port = Number(value ?? 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`PORT 必须是 1 到 65535 之间的整数,当前值为 ${value}`);
  }
  return port;
}

function readEnvironmentFile(envFilePath: string, required: boolean): NodeJS.Dict<string> {
  try {
    return parseEnv(readFileSync(envFilePath, "utf8"));
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    if (required) {
      throw new Error(`找不到环境配置文件 ${envFilePath},请复制 .env.example 并填写模型配置`, { cause: error });
    }
    return {};
  }
}

function projectSettings(file: NodeJS.Dict<string>, inherited: NodeJS.ProcessEnv): AppEnvironment & NodeJS.ProcessEnv {
  return {
    ...inherited,
    ...file,
    // Model selection belongs to this project, even when a field is absent from its file.
    SQL_WEB_PROVIDER: file["SQL_WEB_PROVIDER"],
    SQL_WEB_MODEL: file["SQL_WEB_MODEL"],
  };
}

export function loadProjectEnvironment(
  envFilePath = path.join(PROJECT_ROOT, ".env"),
  target: NodeJS.ProcessEnv = process.env,
): AppEnvironment {
  const file = readEnvironmentFile(envFilePath, true);
  const settings = projectSettings(file, target);
  Object.assign(target, file);
  return Object.fromEntries(webEnvironmentKeys.map((key) => [key, settings[key]]));
}

export function readCommandEnvironment(projectRoot: string, inherited: NodeJS.ProcessEnv = process.env) {
  return projectSettings(readEnvironmentFile(path.join(projectRoot, ".env"), false), inherited);
}

export function requireProjectModel(provider: string | undefined, model: string | undefined): ModelSelection {
  if (!provider || !model) throw new Error("必须在 .env 中同时设置 SQL_WEB_PROVIDER 和 SQL_WEB_MODEL");
  return { provider, model };
}

export function loadConfig(env: AppEnvironment, projectRoot = PROJECT_ROOT): AppConfig {
  const model = requireProjectModel(env.SQL_WEB_PROVIDER?.trim(), env.SQL_WEB_MODEL?.trim());
  const domainVerifyUrl = env.SQL_WEB_DOMAIN_VERIFY_URL?.trim() || DEFAULT_DOMAIN_VERIFY_URL;
  const verificationUrl = new URL(domainVerifyUrl);
  if (!["http:", "https:"].includes(verificationUrl.protocol) || verificationUrl.username || verificationUrl.password) {
    throw new Error("域验证地址必须是无内嵌凭据的 HTTP 或 HTTPS URL");
  }
  if (env.SQL_WEB_AUTH_COOKIE_SECURE && !["true", "false"].includes(env.SQL_WEB_AUTH_COOKIE_SECURE)) {
    throw new Error("SQL_WEB_AUTH_COOKIE_SECURE 必须是 true 或 false");
  }

  const queryTimeoutMs = Number(env.SQL_WEB_QUERY_TIMEOUT_MS ?? 30_000);
  if (!Number.isInteger(queryTimeoutMs) || queryTimeoutMs < 1 || queryTimeoutMs > 2_147_483_647) {
    throw new Error("SQL_WEB_QUERY_TIMEOUT_MS 必须是 1 到 2147483647 之间的整数毫秒数");
  }

  return {
    queryTimeoutMs,
    domainVerifyUrl,
    authCookieSecure: env.SQL_WEB_AUTH_COOKIE_SECURE === "true",
    userDashboardsPath: path.resolve(projectRoot, env.SQL_WEB_USER_DASHBOARDS_PATH ?? ".data/user-dashboards.json"),
    projectRoot,
    host: env.HOST?.trim() || "127.0.0.1",
    port: parsePort(env.PORT),
    ...resolveSharedPaths(env, projectRoot),
    sessionDir: resolveSessionDirectory(env, projectRoot),
    artifactDir: path.resolve(projectRoot, env.SQL_WEB_ARTIFACT_DIR ?? ".data/artifacts"),
    publicDir: path.join(projectRoot, "public"),
    agentDir: path.join(projectRoot, ".data", "agent"),
    logDir: path.join(projectRoot, ".data", "logs"),
    model,
    email: loadEmailConfig(env),
  };
}

export function loadEmailConfig(env: AppEnvironment): EmailConfig | null {
  const values = [env.SQL_WEB_SMTP_HOST, env.SQL_WEB_SMTP_PORT, env.SQL_WEB_MAIL_FROM_ADDRESS, env.SQL_WEB_MAIL_FROM_NAME];
  if (values.every((value) => !value?.trim())) return null;
  const host = env.SQL_WEB_SMTP_HOST?.trim();
  const fromAddress = env.SQL_WEB_MAIL_FROM_ADDRESS;
  const fromName = env.SQL_WEB_MAIL_FROM_NAME;
  if (!host || !fromAddress?.trim() || !fromName?.trim()) {
    throw new Error("启用邮件工具必须同时配置 SQL_WEB_SMTP_HOST、SQL_WEB_MAIL_FROM_ADDRESS 和 SQL_WEB_MAIL_FROM_NAME");
  }
  return validateEmailConfig({
    host,
    port: Number(env.SQL_WEB_SMTP_PORT?.trim() || "25"),
    fromAddress,
    fromName,
  });
}
