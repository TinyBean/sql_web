import { AgentSessionStore } from "./agent-sessions.ts";
import { loadConfig, loadProjectEnvironment } from "./config.ts";
import { DemoDatabase } from "./database.ts";
import { createWebServer } from "./http-server.ts";

const config = loadConfig(loadProjectEnvironment());
const database = DemoDatabase.open({
  filePath: config.databasePath,
  schemaPath: config.schemaPath,
  seedPath: config.seedPath,
});
const sessions = await AgentSessionStore.open({
  database,
  cwd: config.projectRoot,
  sessionDir: config.sessionDir,
  agentDir: config.agentDir,
  model: config.model,
}).catch((error: unknown) => {
  database.close();
  throw error;
});
const server = createWebServer({ database, sessions, publicDir: config.publicDir });

server.once("error", (error) => {
  sessions.dispose();
  database.close();
  throw error;
});

server.listen(config.port, config.host, () => {
  console.log(`数据库问答网站已启动：http://${config.host}:${config.port}`);
  console.log(`SQLite：${config.databasePath}`);
  console.log(`模型：${config.model.provider}/${config.model.model}（${config.agentDir}）`);
  console.log("Agent 工具：query_database, execute_database（原生工具已禁用）");
});

let closing = false;
function shutdown(signal: NodeJS.Signals): void {
  if (closing) return;
  closing = true;
  console.log(`\n收到 ${signal}，正在关闭…`);
  server.close(() => {
    sessions.dispose();
    database.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 5_000).unref();
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
