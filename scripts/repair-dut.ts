import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { PROJECT_ROOT } from "../src/server/config.ts";
import { createDashboardRegistry } from "../src/server/dashboard/index.ts";
import { DailyFileLogger } from "../src/server/logger.ts";
import { loadDataCommandConfig } from "./database/data-command-config.ts";
import { dutRecoveryPlan, recoverDut } from "./database/dut-recovery.ts";
import { outcomeExitCode } from "./database/oee-data-store.ts";

async function main(): Promise<void> {
  process.umask(0o077);
  const plan = dutRecoveryPlan(process.argv.slice(2));
  const config = loadDataCommandConfig(PROJECT_ROOT);
  const runId = randomUUID();
  const logger = new DailyFileLogger(config.logDir, { filenamePrefix: "oee-dut-repair" }).child({ commandRunId: runId });
  const result = await recoverDut({ ...config, ...plan,
    backupDirectory: path.join(PROJECT_ROOT, ".data", "backups") }, logger);
  const dashboards = [];
  if (result.stage === "completed" && result.status !== "failed") {
    // No notification dispatcher is registered for historical recovery.
    for (const definition of createDashboardRegistry(config).list()) {
      if (!definition.update) continue;
      try {
        const outcome = await definition.update({ databasePath: config.databasePath,
          throughDate: plan.dashboardThroughDate, now: new Date(), runId, logger,
          syncWarnings: result.status === "completed_with_warnings" ? ["DUT 历史恢复存在未提交业务日，保留其旧数据"] : [],
        });
        dashboards.push({ dashboardId: definition.id, ...outcome });
        if (outcome.status === "failed") result.status = "failed";
        else if (outcome.status === "completed_with_warnings" && result.status === "completed") result.status = "completed_with_warnings";
      } catch (error) {
        result.status = "failed";
        dashboards.push({ dashboardId: definition.id, status: "failed", error: error instanceof Error ? error.message : String(error) });
      }
    }
  }
  const output = { ...result, dashboardThroughDate: plan.dashboardThroughDate, dashboards };
  await writeFile(result.reportPath, JSON.stringify(output, null, 2) + "\n", { mode: 0o600 });
  console.log(JSON.stringify(output, null, 2));
  process.exitCode = outcomeExitCode(result.status);
}

await main().catch((error: unknown) => {
  console.error(JSON.stringify({ status: "failed", error: error instanceof Error ? error.message : String(error) }));
  process.exitCode = 1;
});
