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
  readonly SQL_WEB_ARTIFACT_DIR?: string | undefined;
  readonly SQL_WEB_PYTHON_PATH?: string | undefined;
  readonly SQL_WEB_BWRAP_PATH?: string | undefined;
  readonly SQL_WEB_PRLIMIT_PATH?: string | undefined;
  readonly SQL_WEB_PROVIDER?: string | undefined;
  readonly SQL_WEB_MODEL?: string | undefined;
}

export interface AppConfig {
  readonly projectRoot: string;
  readonly host: string;
  readonly port: number;
  readonly databasePath: string;
  readonly sessionDir: string;
  readonly artifactDir: string;
  readonly publicDir: string;
  readonly agentDir: string;
  readonly logDir: string;
  readonly model: ModelSelection;
  readonly codeInterpreter: {
    readonly pythonPath: string;
    readonly bwrapPath: string;
    readonly prlimitPath: string;
  };
}

const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
const sourceRoot = path.resolve(moduleDirectory, "../..");
const projectRoot = path.basename(sourceRoot) === "dist"
  ? path.resolve(sourceRoot, "..")
  : sourceRoot;

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
      SQL_WEB_ARTIFACT_DIR: target["SQL_WEB_ARTIFACT_DIR"],
      SQL_WEB_PYTHON_PATH: target["SQL_WEB_PYTHON_PATH"],
      SQL_WEB_BWRAP_PATH: target["SQL_WEB_BWRAP_PATH"],
      SQL_WEB_PRLIMIT_PATH: target["SQL_WEB_PRLIMIT_PATH"],
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
    databasePath: resolveProjectPath(env.SQL_WEB_DB_PATH, ".data/database/oee.sqlite"),
    sessionDir: resolveProjectPath(env.SQL_WEB_SESSION_DIR, ".data/sessions"),
    artifactDir: resolveProjectPath(env.SQL_WEB_ARTIFACT_DIR, ".data/artifacts"),
    publicDir: path.join(projectRoot, "public"),
    agentDir: path.join(projectRoot, ".data", "agent"),
    logDir: path.join(projectRoot, ".data", "logs"),
    model: { provider, model },
    codeInterpreter: {
      pythonPath: path.resolve(env.SQL_WEB_PYTHON_PATH?.trim() || "/usr/bin/python3"),
      bwrapPath: path.resolve(env.SQL_WEB_BWRAP_PATH?.trim() || "/usr/bin/bwrap"),
      prlimitPath: path.resolve(env.SQL_WEB_PRLIMIT_PATH?.trim() || "/usr/bin/prlimit"),
    },
  };
}
