import { createHash } from "node:crypto";
import path from "node:path";

function shellQuote(value: string): string {
  if (/[\r\n\0]/u.test(value)) throw new Error("定时任务路径不能包含换行或空字符");
  return "'" + value.replaceAll("'", "'\\''") + "'";
}

export function dailyCronBlock(projectRoot: string, nodePath: string): string {
  const root = path.resolve(projectRoot);
  const marker = "sql-web-daily-" + createHash("sha256").update(root).digest("hex").slice(0, 12);
  const command = "cd -- " + shellQuote(root) + " && SQL_WEB_NODE_PATH=" + shellQuote(nodePath) +
    " /bin/bash " + shellQuote(path.join(root, "scripts", "oee-daily.sh")) + " --cron";
  return [
    "# BEGIN " + marker,
    "# Daily at 09:00 Asia/Shanghai (host timezone); refresh the last closed business day.",
    "0 9 * * * " + command.replaceAll("%", "\\%"),
    "# END " + marker,
  ].join("\n");
}

export function updateDailyCrontab(existing: string, block: string): string {
  const blockLines = block.split("\n");
  const begin = blockLines[0]!;
  const end = blockLines.at(-1)!;
  const lines = existing.trimEnd().split("\n");
  const output: string[] = [];
  let inside = false;
  for (const line of lines) {
    if (line === begin) {
      if (inside) throw new Error("现有定时任务标记嵌套，无法安全更新");
      inside = true;
    } else if (line === end) {
      if (!inside) throw new Error("现有定时任务标记不完整");
      inside = false;
    } else if (!inside) output.push(line);
  }
  if (inside) throw new Error("现有定时任务缺少结束标记");
  const preserved = output.join("\n").trimEnd();
  return (preserved ? preserved + "\n\n" : "") + block + "\n";
}
