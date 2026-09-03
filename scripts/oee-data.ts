import path from "node:path";
import { readFileSync } from "node:fs";
import { parseEnv } from "node:util";
import { FileLogger } from "../src/server/logger.ts";
import { OeeDataStore, parseOeeDataset } from "../src/server/data/oee-data.ts";

const projectRoot = path.basename(path.resolve(import.meta.dirname, "..")) === "dist"
  ? path.resolve(import.meta.dirname, "../..")
  : path.resolve(import.meta.dirname, "..");
const logger = new FileLogger(path.join(projectRoot, ".data", "logs", "oee-data.log"));

function requiredArgument(value: string | undefined, name: string): string {
  if (!value) throw new Error(`缺少参数 ${name}`);
  return value;
}

function usage(): never {
  throw new Error(
    [
      "用法：",
      "  npm run data:import -- <dataset> <json-file> <start-date> <end-date>",
      "  npm run data:pull -- <dataset> <start-date> <end-date>",
      "  npm run data:sync -- <dataset|all> <through-date> [initial-start-date]",
      "  npm run data:status",
      "dataset: availability | dut_utilization；日期格式：YYYY-MM-DD",
    ].join("\n"),
  );
}

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);
  if (!command) usage();
  logger.info("oee.command.started", { command, args });
  let fileEnvironment: Record<string, string | undefined> = {};
  try {
    fileEnvironment = parseEnv(readFileSync(path.join(projectRoot, ".env"), "utf8"));
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
  }
  const databasePath = path.resolve(
    projectRoot,
    process.env["SQL_WEB_DB_PATH"] ?? fileEnvironment["SQL_WEB_DB_PATH"] ?? ".data/database/oee.sqlite",
  );
  const apiBaseUrl = process.env["OEE_API_BASE_URL"] ?? fileEnvironment["OEE_API_BASE_URL"];
  const store = OeeDataStore.open({
    databasePath,
    schemaPath: path.join(projectRoot, "sql", "schema.sql"),
    ...(apiBaseUrl ? { apiBaseUrl } : {}),
    logger,
  });

  try {
    if (command === "import") {
      const dataset = parseOeeDataset(requiredArgument(args[0], "dataset"));
      const filePath = path.resolve(projectRoot, requiredArgument(args[1], "json-file"));
      const result = await store.importFile({
        dataset,
        filePath,
        requestedStartDate: requiredArgument(args[2], "start-date"),
        requestedEndDate: requiredArgument(args[3], "end-date"),
      });
      console.log(JSON.stringify(result, null, 2));
      logger.info("oee.command.completed", { command });
      return;
    }

    if (command === "pull") {
      const result = await store.pullWindow({
        dataset: parseOeeDataset(requiredArgument(args[0], "dataset")),
        startDate: requiredArgument(args[1], "start-date"),
        endDate: requiredArgument(args[2], "end-date"),
      });
      console.log(JSON.stringify(result, null, 2));
      logger.info("oee.command.completed", { command });
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
      logger.info("oee.command.completed", { command });
      return;
    }

    if (command === "status") {
      console.log(JSON.stringify(store.getStatus(), null, 2));
      logger.info("oee.command.completed", { command });
      return;
    }

    usage();
  } finally {
    store.close();
  }
}

await main().catch((error: unknown) => {
  logger.error("oee.command.failed", error);
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
