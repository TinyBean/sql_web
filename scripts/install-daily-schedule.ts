import { spawnSync } from "node:child_process";
import { accessSync, constants, realpathSync } from "node:fs";
import path from "node:path";
import { PROJECT_ROOT } from "../src/server/config.ts";
import { dailyCronBlock, updateDailyCrontab } from "./scheduling/daily-cron.ts";

function command(executable: string, args: string[], input?: string) {
  const result = spawnSync(executable, args, {
    encoding: "utf8", env: { ...process.env, LC_ALL: "C" },
    ...(input === undefined ? {} : { input }),
  });
  if (result.error) throw result.error;
  return result;
}

function readCrontab(): string {
  const result = command("/usr/bin/crontab", ["-l"]);
  if (result.status === 0) return result.stdout;
  if (result.status === 1 && /^no crontab for /u.test(result.stderr.trim())) return "";
  throw new Error("无法读取现有 crontab：" + result.stderr.trim());
}

function main(): void {
  const args = process.argv.slice(2);
  if (args.length && !(args.length === 1 && args[0] === "--dry-run")) {
    throw new Error("用法：npm run schedule:install -- [--dry-run]");
  }
  if (!realpathSync("/etc/localtime").endsWith("/Asia/Shanghai")) {
    throw new Error("主机 cron 时区必须为 Asia/Shanghai；脚本不会更改系统时区");
  }
  const service = command("/usr/bin/systemctl", ["is-active", "cron.service"]);
  if (service.status !== 0 || service.stdout.trim() !== "active") throw new Error("cron.service 未运行");
  accessSync("/usr/bin/flock", constants.X_OK);
  accessSync(process.execPath, constants.X_OK);
  accessSync(path.join(PROJECT_ROOT, "scripts", "oee-daily.sh"), constants.R_OK);
  accessSync(path.join(PROJECT_ROOT, "node_modules", "tsx", "package.json"), constants.R_OK);
  const current = readCrontab();
  const block = dailyCronBlock(PROJECT_ROOT, process.execPath);
  const next = updateDailyCrontab(current, block);
  if (args[0] === "--dry-run") {
    console.log(block);
    return;
  }
  if (next !== current) {
    const result = command("/usr/bin/crontab", ["-"], next);
    if (result.status !== 0) throw new Error("安装 crontab 失败：" + result.stderr.trim());
  }
  if (readCrontab() !== next) throw new Error("安装后的 crontab 与预期不一致");
  console.log(JSON.stringify({ installed: true, changed: next !== current, timezone: "Asia/Shanghai", schedule: "0 9 * * *", projectRoot: PROJECT_ROOT }));
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
