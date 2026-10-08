import path from "node:path";
import { randomUUID } from "node:crypto";
import { loadDataCommandConfig } from "./database/data-command-config.ts";
import { DailyFileLogger, type AppLogger } from "../src/server/logger.ts";
import { assertDate } from "../src/server/database/business-dates.ts";
import { initializeOeeDatabase } from "./database/initialize.ts";
import {
  OeeDataStore,
  outcomeExitCode,
  parseOeeDataset,
  type SyncOptions,
} from "./database/oee-data-store.ts";

const projectRoot = path.basename(path.resolve(import.meta.dirname, "..")) === "dist"
  ? path.resolve(import.meta.dirname, "../..")
  : path.resolve(import.meta.dirname, "..");
let logger: AppLogger | undefined;

function usage(): never {
  throw new Error(
    [
      "用法:",
      "  npm run data:init",
      "  npm run data:sync -- <dataset|all> <through-date> [initial-start-date]",
      "dataset: availability | dut_utilization;日期格式:YYYY-MM-DD",
      "所有日期参数使用业务日期；空表首次同步必须提供 initial-start-date。",
    ].join("\n"),
  );
}

function syncOptions(args: readonly string[]): SyncOptions {
  if (args.length < 2 || args.length > 3) usage();
  const dataset = args[0] === "all" ? "all" : parseOeeDataset(args[0]!);
  const throughDate = args[1]!;
  const initialStartDate = args[2];
  assertDate(throughDate);
  if (initialStartDate !== undefined) {
    assertDate(initialStartDate);
    if (initialStartDate > throughDate) {
      throw new Error(`initialStartDate ${initialStartDate} 不能晚于 throughDate ${throughDate}`);
    }
  }
  return { dataset, throughDate, ...(initialStartDate ? { initialStartDate } : {}) };
}

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);
  if (command !== "init" && command !== "sync") usage();
  if (command === "init" && args.length) usage();
  const options = command === "sync" ? syncOptions(args) : undefined;
  logger = new DailyFileLogger(path.join(projectRoot, ".data", "logs"), {
    filenamePrefix: "oee-data",
  }).child({ commandRunId: randomUUID() });
  const startedAt = Date.now();
  logger.info("oee.command.started", { stage: "command", command, args });
  const config = loadDataCommandConfig(projectRoot);
  const { databasePath } = config;
  if (!options) {
    initializeOeeDatabase(databasePath);
    console.log(JSON.stringify({ databasePath, initialized: true }, null, 2));
    logger.info("oee.command.completed", {
      stage: "command", command, databasePath, status: "completed",
      durationMs: Date.now() - startedAt,
    });
    return;
  }
  const store = OeeDataStore.open({ ...config, logger });
  try {
    const result = await store.sync(options);
    console.log(JSON.stringify(result, null, 2));
    process.exitCode = outcomeExitCode(result.status);
    logger.info("oee.command.completed", {
      stage: "command", command, status: result.status, importRunId: result.runId,
      durationMs: Date.now() - startedAt,
    });
  } finally {
    store.close();
  }
}

await main().catch((error: unknown) => {
  logger?.error("oee.command.failed", error, { stage: "command", retryable: false });
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
