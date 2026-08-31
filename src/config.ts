import { readFileSync } from "node:fs";
import path from "node:path";
import { parseEnv } from "node:util";
import { fileURLToPath } from "node:url";

export interface ModelOverride {
  provider: string;
  model: string;
}

export interface AppConfig {
  projectRoot: string;
  host: string;
  port: number;
  databasePath: string;
  sessionDir: string;
  publicDir: string;
  schemaPath: string;
  seedPath: string;
  agentDir: string;
  model: ModelOverride;
}

const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.basename(path.dirname(moduleDirectory)) === "dist"
  ? path.resolve(moduleDirectory, "../..")
  : path.resolve(moduleDirectory, "..");

function resolveProjectPath(value: string | undefined, fallback: string): string {
  return path.resolve(projectRoot, value || fallback);
}

function parsePort(value: string | undefined): number {
  const port = Number(value || 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`PORT 必须是 1 到 65535 之间的整数，当前值为 ${value}`);
  }
  return port;
}

export function loadProjectEnvironment(
  envFilePath = path.join(projectRoot, ".env"),
  target: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  try {
    const values = parseEnv(readFileSync(envFilePath, "utf8"));
    Object.assign(target, values);
    return target;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      throw new Error(`找不到环境配置文件 ${envFilePath}，请复制 .env.example 并填写模型配置`, {
        cause: error,
      });
    }
    throw error;
  }
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const provider = env.SQL_WEB_PROVIDER?.trim();
  const model = env.SQL_WEB_MODEL?.trim();
  if (!provider || !model) {
    throw new Error("必须在 .env 中同时设置 SQL_WEB_PROVIDER 和 SQL_WEB_MODEL");
  }

  return {
    projectRoot,
    host: env.HOST?.trim() || "127.0.0.1",
    port: parsePort(env.PORT),
    databasePath: resolveProjectPath(env.SQL_WEB_DB_PATH, ".data/demo.sqlite"),
    sessionDir: resolveProjectPath(env.SQL_WEB_SESSION_DIR, ".data/sessions"),
    publicDir: path.join(projectRoot, "public"),
    schemaPath: path.join(projectRoot, "sql", "schema.sql"),
    seedPath: path.join(projectRoot, "sql", "seed.sql"),
    agentDir: path.join(projectRoot, ".data", "agent"),
    model: { provider, model },
  };
}
