import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { PROJECT_ROOT } from "../../src/server/config.ts";
import { dailyCronBlock, updateDailyCrontab } from "../../scripts/scheduling/daily-cron.ts";

test("cron installation is idempotent and preserves unrelated entries", () => {
  const other = "MAILTO=ops\n15 3 * * * /bin/true\n";
  const block = dailyCronBlock("/home/joker/sql_web", "/usr/local/bin/node");
  const first = updateDailyCrontab(other, block);
  assert.ok(first.startsWith(other));
  assert.equal(updateDailyCrontab(first, block), first);
  const upgraded = dailyCronBlock("/home/joker/sql_web", "/opt/node/bin/node");
  const next = updateDailyCrontab(first, upgraded);
  assert.equal(next.split("0 9 * * *").length, 2);
  assert.ok(next.includes("/opt/node/bin/node"));
  assert.ok(!next.includes("/usr/local/bin/node"));
  assert.throws(() => updateDailyCrontab(block.split("\n").slice(0, -1).join("\n"), block), /缺少结束/u);
});

test("cron commands quote paths and escape cron's percent separator", (t) => {
  const directory = mkdtempSync(path.join(tmpdir(), "daily-cron-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const root = path.join(directory, "with space'and%percent");
  mkdirSync(path.join(root, "scripts"), { recursive: true });
  writeFileSync(path.join(root, "scripts", "oee-daily.sh"), 'printf "%s" "$SQL_WEB_NODE_PATH"');
  const nodePath = "/path with ' quote/node";
  const block = dailyCronBlock(root, nodePath);
  const line = block.split("\n").find((item) => item.startsWith("0 9"))!;
  assert.ok(line.includes("\\%"));
  const result = spawnSync("/bin/sh", ["-c", line.slice("0 9 * * * ".length).replaceAll("\\%", "%")], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, nodePath);
  assert.throws(() => dailyCronBlock("/bad\npath", "/usr/bin/node"));
});

test("the shared daily entry skips overlapping invocations", { timeout: 10_000 }, async (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "daily-flock-"));
  mkdirSync(path.join(root, "scripts"));
  const wrapper = path.join(root, "scripts", "oee-daily.sh");
  copyFileSync(path.join(PROJECT_ROOT, "scripts", "oee-daily.sh"), wrapper);
  const node = path.join(root, "fake-node");
  writeFileSync(node, [
    "#!/bin/sh",
    "echo started",
    "echo run >> launches",
    "while [ ! -f release ]; do /usr/bin/sleep 0.01; done",
  ].join("\n"), { mode: 0o700 });
  const env = { ...process.env, SQL_WEB_NODE_PATH: node };
  const first = spawn("/bin/bash", [wrapper], { env });
  const closed = once(first, "close");
  t.after(() => {
    writeFileSync(path.join(root, "release"), "");
    first.kill();
    rmSync(root, { recursive: true, force: true });
  });
  await once(first.stdout, "data");
  const second = spawnSync("/bin/bash", [wrapper], { env, encoding: "utf8" });
  assert.equal(second.status, 0, second.stderr);
  assert.match(second.stdout, /already running/u);
  writeFileSync(path.join(root, "release"), "");
  assert.equal((await closed)[0], 0);
  assert.equal(readFileSync(path.join(root, "launches"), "utf8"), "run\n");
});
