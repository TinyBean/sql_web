import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type { ModelSelection } from "../../shared/contracts.ts";

export class LocalModelCatalogError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "LocalModelCatalogError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseCatalogFile(filePath: string): unknown {
  try {
    const value: unknown = JSON.parse(readFileSync(filePath, "utf8"));
    return value;
  } catch (error) {
    throw new LocalModelCatalogError(`无法解析本地模型文件 ${filePath}`, { cause: error });
  }
}

function catalogKey(provider: string, model: string): string {
  return `${provider}\0${model}`;
}

function addModelArray(
  keys: Set<string>,
  provider: string,
  models: unknown,
  source: string,
): void {
  if (!Array.isArray(models)) {
    throw new LocalModelCatalogError(`${source} 中 ${provider}.models 必须是数组`);
  }
  for (const [index, value] of models.entries()) {
    if (!isRecord(value) || typeof value["id"] !== "string" || !value["id"].trim()) {
      throw new LocalModelCatalogError(`${source} 中 ${provider}.models[${index}].id 必须是非空字符串`);
    }
    keys.add(catalogKey(provider, value["id"]));
  }
}

function collectModelsStore(keys: Set<string>, filePath: string): void {
  const value = parseCatalogFile(filePath);
  if (!isRecord(value)) {
    throw new LocalModelCatalogError(`${filePath} 的顶层必须是 provider 对象`);
  }
  for (const [provider, entry] of Object.entries(value)) {
    if (Array.isArray(entry)) {
      addModelArray(keys, provider, entry, filePath);
      continue;
    }
    if (!isRecord(entry) || !("models" in entry)) {
      throw new LocalModelCatalogError(`${filePath} 中 ${provider} 缺少 models 数组`);
    }
    addModelArray(keys, provider, entry["models"], filePath);
  }
}

function collectModelsConfig(keys: Set<string>, filePath: string): void {
  const value = parseCatalogFile(filePath);
  if (!isRecord(value) || !isRecord(value["providers"])) {
    throw new LocalModelCatalogError(`${filePath} 必须包含 providers 对象`);
  }
  for (const [provider, config] of Object.entries(value["providers"])) {
    if (!isRecord(config)) {
      throw new LocalModelCatalogError(`${filePath} 中 provider ${provider} 必须是对象`);
    }
    if (config["models"] !== undefined) {
      addModelArray(keys, provider, config["models"], filePath);
    }
    const overrides = config["modelOverrides"];
    if (overrides !== undefined) {
      if (!isRecord(overrides)) {
        throw new LocalModelCatalogError(`${filePath} 中 ${provider}.modelOverrides 必须是对象`);
      }
      for (const model of Object.keys(overrides)) keys.add(catalogKey(provider, model));
    }
  }
}

export function assertModelInLocalCatalog(agentDir: string, selection: ModelSelection): void {
  const modelsPath = path.join(agentDir, "models.json");
  const modelsStorePath = path.join(agentDir, "models-store.json");
  const hasModels = existsSync(modelsPath);
  const hasStore = existsSync(modelsStorePath);
  if (!hasModels && !hasStore) {
    throw new LocalModelCatalogError(
      `在 ${agentDir} 中找不到 models.json 或 models-store.json，无法加载模型列表`,
    );
  }

  const keys = new Set<string>();
  if (hasStore) collectModelsStore(keys, modelsStorePath);
  if (hasModels) collectModelsConfig(keys, modelsPath);
  if (!keys.has(catalogKey(selection.provider, selection.model))) {
    throw new LocalModelCatalogError(
      `.env 指定的模型 ${selection.provider}/${selection.model} 未在 ${agentDir} 的本地模型文件中声明`,
    );
  }
}
