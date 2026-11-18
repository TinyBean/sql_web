import { existsSync, readFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";

export const pausingWorker = new URL(import.meta.url.endsWith(".ts")
  ? "./pausing-query-worker.ts" : "./pausing-query-worker.js", import.meta.url);
export const pausedAggregate = "SELECT SUM(test_pause(?)) AS total";

export async function queryPid(marker: string): Promise<number> {
  const deadline = performance.now() + 8_000;
  while (performance.now() < deadline) {
    if (existsSync(marker)) {
      const pid = Number(readFileSync(marker, "utf8"));
      if (pid > 0) return pid;
    }
    await delay(10);
  }
  throw new Error("Test SQLite aggregate did not start");
}
