import path from "node:path";
import { randomUUID } from "node:crypto";
import { loadDataCommandConfig } from "./database/data-command-config.ts";
import { DailyFileLogger } from "../src/server/logger.ts";
import { initializeOeeDatabase } from "./database/initialize.ts";
import {
  OeeDataStore,
  outcomeExitCode,
  parseOeeDataset,
} from "./database/oee-data-store.ts";

const projectRoot = path.basename(path.resolve(import.meta.dirname, "..")) === "dist"
  ? path.resolve(import.meta.dirname, "../..")
  : path.resolve(import.meta.dirname, "..");
const logger = new DailyFileLogger(path.join(projectRoot, ".data", "logs"), {
  filenamePrefix: "oee-data",
}).child({ commandRunId: randomUUID() });

function requiredArgument(value: string | undefined, name: string): string {
  if (!value) throw new Error(`缺少参数 ${name}`);
  return value;
}

function usage(): never {
  throw new Error(
    [
      "用法:",
      "  npm run data:init",
      "  npm run data:import -- <dataset> <json-file> <start-date> <end-date> [--request-start YYYY-MM-DD --request-end YYYY-MM-DD]",
      "  npm run data:pull -- <dataset> <start-date> <end-date>",
      "  npm run data:sync -- <dataset|all> <through-date> [initial-start-date]",
      "  npm run data:reimport -- <dataset> <start-date> <end-date>",
      "  npm run data:status",
      "dataset: availability | dut_utilization;日期格式:YYYY-MM-DD",
      "所有日期参数使用业务日期；DUT 文件导入必须显式提供原始 API 请求范围，DUT pull 仅支持一个业务日。",
    ].join("\n"),
  );
}

function applyExitCode(status: Parameters<typeof outcomeExitCode>[0]): void {
  process.exitCode = outcomeExitCode(status);
}

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);
  if (!command) usage();
  const startedAt = Date.now();
  logger.info("oee.command.started", { stage: "command", command, args });
  const config = loadDataCommandConfig(projectRoot);
  const { databasePath } = config;
  if (command === "init") {
    initializeOeeDatabase(databasePath);
    console.log(JSON.stringify({ databasePath, initialized: true }, null, 2));
    logger.info("oee.command.completed", {
      stage: "command",
      command,
      databasePath,
      status: "completed",
      durationMs: Date.now() - startedAt,
    });
    return;
  }
  const store = OeeDataStore.open({ ...config, logger });

  try {
    if (command === "import") {
      const dataset = parseOeeDataset(requiredArgument(args[0], "dataset"));
      const filePath = path.resolve(projectRoot, requiredArgument(args[1], "json-file"));
      const requestDates = new Map<string, string>();
      for (let index = 4; index < args.length; index += 2) {
        const flag = args[index]!;
        if (!["--request-start", "--request-end"].includes(flag) || requestDates.has(flag)) usage();
        requestDates.set(flag, requiredArgument(args[index + 1], flag));
      }
      if (requestDates.size === 1) throw new Error("--request-start 和 --request-end 必须同时提供");
      const result = await store.importFile({
        dataset,
        filePath,
        startDate: requiredArgument(args[2], "start-date"),
        endDate: requiredArgument(args[3], "end-date"),
        ...(requestDates.size ? {
          requestedStartDate: requestDates.get("--request-start")!,
          requestedEndDate: requestDates.get("--request-end")!,
        } : {}),
      });
      console.log(JSON.stringify(result, null, 2));
      applyExitCode(result.status);
      logger.info("oee.command.completed", {
        stage: "command",
        command,
        status: result.status,
        importRunId: result.runId,
        durationMs: Date.now() - startedAt,
      });
      return;
    }

    if (command === "pull") {
      const result = await store.pullWindow({
        dataset: parseOeeDataset(requiredArgument(args[0], "dataset")),
        startDate: requiredArgument(args[1], "start-date"),
        endDate: requiredArgument(args[2], "end-date"),
      });
      console.log(JSON.stringify(result, null, 2));
      applyExitCode(result.status);
      logger.info("oee.command.completed", {
        stage: "command",
        command,
        status: result.status,
        importRunId: result.runId,
        durationMs: Date.now() - startedAt,
      });
      return;
    }

    if (command === "sync") {
      const datasetArgument = requiredArgument(args[0], "dataset|all");
      const dataset = datasetArgument === "all" ? "all" : parseOeeDataset(datasetArgument);
      const initialStartDate = args[2];
      const result = await store.sync({
        dataset,
        throughDate: requiredArgument(args[1], "through-date"),
        ...(initialStartDate ? { initialStartDate } : {}),
      });
      console.log(JSON.stringify(result, null, 2));
      applyExitCode(result.status);
      logger.info("oee.command.completed", {
        stage: "command",
        command,
        status: result.status,
        importRunId: result.runId,
        durationMs: Date.now() - startedAt,
      });
      return;
    }

    if (command === "reimport") {
      const result = await store.reimport({
        dataset: parseOeeDataset(requiredArgument(args[0], "dataset")),
        startDate: requiredArgument(args[1], "start-date"),
        endDate: requiredArgument(args[2], "end-date"),
      });
      console.log(JSON.stringify(result, null, 2));
      applyExitCode(result.status);
      logger.info("oee.command.completed", {
        stage: "command",
        command,
        status: result.status,
        importRunId: result.runId,
        durationMs: Date.now() - startedAt,
      });
      return;
    }

    if (command === "status") {
      console.log(JSON.stringify(store.getStatus(), null, 2));
      logger.info("oee.command.completed", {
        stage: "command",
        command,
        status: "completed",
        durationMs: Date.now() - startedAt,
      });
      return;
    }

    usage();
  } finally {
    store.close();
  }
}

await main().catch((error: unknown) => {
  logger.error("oee.command.failed", error, { stage: "command", retryable: false });
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
