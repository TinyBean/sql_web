import { readFileSync } from "node:fs";
import path from "node:path";
import { parseEnv } from "node:util";
import { fileURLToPath } from "node:url";
import type { ModelSelection } from "../shared/contracts.ts";
import { validateEmailConfig, type EmailConfig } from "./email.ts";

export interface AppEnvironment {
  readonly HOST?: string | undefined;
  readonly PORT?: string | undefined;
  readonly SQL_WEB_DB_PATH?: string | undefined;
  readonly SQL_WEB_SESSION_DIR?: string | undefined;
  readonly SQL_WEB_ARTIFACT_DIR?: string | undefined;
  readonly SQL_WEB_DEFAULT_DASHBOARD_PATH?: string | undefined;
  readonly SQL_WEB_PYTHON_PATH?: string | undefined;
  readonly SQL_WEB_BWRAP_PATH?: string | undefined;
  readonly SQL_WEB_PRLIMIT_PATH?: string | undefined;
  readonly SQL_WEB_PROVIDER?: string | undefined;
  readonly SQL_WEB_MODEL?: string | undefined;
  readonly SQL_WEB_SMTP_HOST?: string | undefined;
  readonly SQL_WEB_SMTP_PORT?: string | undefined;
  readonly SQL_WEB_MAIL_FROM_ADDRESS?: string | undefined;
  readonly SQL_WEB_MAIL_FROM_NAME?: string | undefined;
}

export interface AppConfig {
  readonly projectRoot: string;
  readonly host: string;
  readonly port: number;
  readonly databasePath: string;
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

function resolveProjectPath(value: string | undefined, fallback: string): string {
  return path.resolve(PROJECT_ROOT, value ?? fallback);
}

function parsePort(value: string | undefined): number {
  const port = Number(value ?? 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`PORT 必须是 1 到 65535 之间的整数,当前值为 ${value}`);
  }
  return port;
}

export function loadProjectEnvironment(
  envFilePath = path.join(PROJECT_ROOT, ".env"),
  target: NodeJS.ProcessEnv = process.env,
): AppEnvironment {
  try {
    const values = parseEnv(readFileSync(envFilePath, "utf8"));
    Object.assign(target, values);
    return {
      HOST: target["HOST"],
      PORT: target["PORT"],
      SQL_WEB_DB_PATH: target["SQL_WEB_DB_PATH"],
      SQL_WEB_SESSION_DIR: target["SQL_WEB_SESSION_DIR"],
      SQL_WEB_ARTIFACT_DIR: target["SQL_WEB_ARTIFACT_DIR"],
      SQL_WEB_DEFAULT_DASHBOARD_PATH: target["SQL_WEB_DEFAULT_DASHBOARD_PATH"],
      SQL_WEB_PYTHON_PATH: target["SQL_WEB_PYTHON_PATH"],
      SQL_WEB_BWRAP_PATH: target["SQL_WEB_BWRAP_PATH"],
      SQL_WEB_PRLIMIT_PATH: target["SQL_WEB_PRLIMIT_PATH"],
      SQL_WEB_SMTP_HOST: target["SQL_WEB_SMTP_HOST"],
      SQL_WEB_SMTP_PORT: target["SQL_WEB_SMTP_PORT"],
      SQL_WEB_MAIL_FROM_ADDRESS: target["SQL_WEB_MAIL_FROM_ADDRESS"],
      SQL_WEB_MAIL_FROM_NAME: target["SQL_WEB_MAIL_FROM_NAME"],
      // The model must come from this project's .env, never from inherited shell state.
      SQL_WEB_PROVIDER: values["SQL_WEB_PROVIDER"],
      SQL_WEB_MODEL: values["SQL_WEB_MODEL"],
    };
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      throw new Error(`找不到环境配置文件 ${envFilePath},请复制 .env.example 并填写模型配置`, {
        cause: error,
      });
    }
    throw error;
  }
}

export function loadConfig(env: AppEnvironment): AppConfig {
  const provider = env.SQL_WEB_PROVIDER?.trim();
  const model = env.SQL_WEB_MODEL?.trim();
  if (!provider || !model) {
    throw new Error("必须在 .env 中同时设置 SQL_WEB_PROVIDER 和 SQL_WEB_MODEL");
  }

  return {
    projectRoot: PROJECT_ROOT,
    host: env.HOST?.trim() || "127.0.0.1",
    port: parsePort(env.PORT),
    databasePath: resolveProjectPath(env.SQL_WEB_DB_PATH, ".data/database/oee.sqlite"),
    sessionDir: resolveProjectPath(env.SQL_WEB_SESSION_DIR, ".data/sessions"),
    artifactDir: resolveProjectPath(env.SQL_WEB_ARTIFACT_DIR, ".data/artifacts"),
    defaultDashboardPath: resolveProjectPath(env.SQL_WEB_DEFAULT_DASHBOARD_PATH, ".data/default-dashboard.json"),
    publicDir: path.join(PROJECT_ROOT, "public"),
    agentDir: path.join(PROJECT_ROOT, ".data", "agent"),
    logDir: path.join(PROJECT_ROOT, ".data", "logs"),
    model: { provider, model },
    email: loadEmailConfig(env),
    codeInterpreter: {
      pythonPath: path.resolve(env.SQL_WEB_PYTHON_PATH?.trim() || "/usr/bin/python3"),
      bwrapPath: path.resolve(env.SQL_WEB_BWRAP_PATH?.trim() || "/usr/bin/bwrap"),
      prlimitPath: path.resolve(env.SQL_WEB_PRLIMIT_PATH?.trim() || "/usr/bin/prlimit"),
    },
  };
}

function loadEmailConfig(env: AppEnvironment): EmailConfig | null {
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
