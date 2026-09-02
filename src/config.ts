import { readFileSync } from "node:fs";
import path from "node:path";
import { parseEnv } from "node:util";
import { fileURLToPath } from "node:url";
import type { ModelSelection } from "../shared/contracts.ts";

export interface AppEnvironment {
  readonly HOST?: string | undefined;
  readonly PORT?: string | undefined;
  readonly SQL_WEB_DB_PATH?: string | undefined;
  readonly SQL_WEB_SESSION_DIR?: string | undefined;
  readonly SQL_WEB_PROVIDER?: string | undefined;
  readonly SQL_WEB_MODEL?: string | undefined;
}

export interface AppConfig {
  readonly projectRoot: string;
  readonly host: string;
  readonly port: number;
  readonly databasePath: string;
  readonly sessionDir: string;
  readonly publicDir: string;
  readonly schemaPath: string;
  readonly agentDir: string;
  readonly logDir: string;
  readonly model: ModelSelection;
}

const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.basename(path.dirname(moduleDirectory)) === "dist"
  ? path.resolve(moduleDirectory, "../..")
  : path.resolve(moduleDirectory, "..");

function resolveProjectPath(value: string | undefined, fallback: string): string {
  return path.resolve(projectRoot, value ?? fallback);
}

function parsePort(value: string | undefined): number {
  const port = Number(value ?? 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`PORT 必须是 1 到 65535 之间的整数，当前值为 ${value}`);
  }
  return port;
}

export function loadProjectEnvironment(
  envFilePath = path.join(projectRoot, ".env"),
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
      // The model must come from this project's .env, never from inherited shell state.
      SQL_WEB_PROVIDER: values["SQL_WEB_PROVIDER"],
      SQL_WEB_MODEL: values["SQL_WEB_MODEL"],
    };
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      throw new Error(`找不到环境配置文件 ${envFilePath}，请复制 .env.example 并填写模型配置`, {
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
    projectRoot,
    host: env.HOST?.trim() || "127.0.0.1",
    port: parsePort(env.PORT),
    databasePath: resolveProjectPath(env.SQL_WEB_DB_PATH, ".data/oee.sqlite"),
    sessionDir: resolveProjectPath(env.SQL_WEB_SESSION_DIR, ".data/sessions"),
    publicDir: path.join(projectRoot, "public"),
    schemaPath: path.join(projectRoot, "sql", "schema.sql"),
    agentDir: path.join(projectRoot, ".data", "agent"),
    logDir: path.join(projectRoot, ".data", "logs"),
    model: { provider, model },
  };
}
