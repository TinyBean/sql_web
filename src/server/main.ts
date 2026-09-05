import path from "node:path";
import { AgentSessionStore } from "./agent/agent-sessions.ts";
import { ArtifactStore } from "./tool/artifact-store.ts";
import { CodeInterpreterRuntime } from "./tool/code-interpreter.ts";
import { loadConfig, loadProjectEnvironment } from "./config.ts";
import { AppDatabase } from "./database/database.ts";
import { createWebServer } from "./http-server.ts";
import { DailyFileLogger } from "./logger.ts";

const config = loadConfig(loadProjectEnvironment());
const logger = new DailyFileLogger(config.logDir, { filenamePrefix: "sql_web" });
logger.info("system.starting", {
  host: config.host,
  port: config.port,
  databasePath: config.databasePath,
  provider: config.model.provider,
  model: config.model.model,
});
const database = AppDatabase.open({ filePath: config.databasePath });
const artifacts = new ArtifactStore(config.artifactDir);
const codeInterpreter = await CodeInterpreterRuntime.create({
  ...config.codeInterpreter,
  projectRoot: config.projectRoot,
});
if (codeInterpreter.status.available) {
  logger.info("code_interpreter.available", {
    pythonPath: config.codeInterpreter.pythonPath,
  });
} else {
  logger.warn("code_interpreter.unavailable", {
    reason: codeInterpreter.status.reason,
  });
}
const sessions = await AgentSessionStore.open({
  database,
  artifacts,
  codeInterpreter,
  cwd: config.projectRoot,
  sessionDir: config.sessionDir,
  agentDir: config.agentDir,
  model: config.model,
  logger,
}).catch((error: unknown) => {
  logger.error("agent.store.open_failed", error);
  codeInterpreter.dispose();
  database.close();
  throw error;
});
const server = createWebServer({
  database,
  sessions,
  publicDir: config.publicDir,
  vendorDir: path.join(config.projectRoot, "node_modules"),
  logger,
});

server.once("error", (error) => {
  logger.error("system.server.error", error);
  sessions.dispose();
  database.close();
  throw error;
});

server.listen(config.port, config.host, () => {
  logger.info("system.started", { host: config.host, port: config.port });
  console.log(`数据库问答网站已启动:http://${config.host}:${config.port}`);
  console.log(`日志:${config.logDir}/sql_web-YYYY-MM-DD.log`);
});

let closing = false;
function shutdown(signal: NodeJS.Signals): void {
  if (closing) return;
  closing = true;
  logger.info("system.stopping", { signal });
  console.log(`\n收到 ${signal},正在关闭…`);
  server.close(() => {
    sessions.dispose();
    database.close();
    logger.info("system.stopped", { signal });
    process.exit(0);
  });
  setTimeout(() => {
    logger.error("system.shutdown.timeout", new Error("服务未能在 5 秒内关闭"), { signal });
    process.exit(1);
  }, 5_000).unref();
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
