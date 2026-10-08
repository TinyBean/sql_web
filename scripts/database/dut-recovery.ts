import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import path from "node:path";
import { backup, DatabaseSync } from "node:sqlite";
import { addDays, assertDate, latestClosedBusinessDate } from "../../src/server/database/business-dates.ts";
import type { AppLogger } from "../../src/server/logger.ts";
import { initializeOeeDatabase } from "./initialize.ts";
import { OeeDataStore, type ImportResult, type OeeDataStoreOptions, type RunOutcome, type SyncResult } from "./oee-data-store.ts";

export interface DutRecoveryOptions extends OeeDataStoreOptions {
  readonly backupDirectory: string;
  readonly startDate: string;
  readonly throughDate: string;
  readonly verifyOnly?: boolean;
}

export interface DutRecoveryResult {
  status: RunOutcome;
  stage: "backup" | "verification" | "verified" | "reimport" | "completed";
  productionChanged: boolean;
  startDate: string;
  throughDate: string;
  backupPath: string;
  verificationPath: string;
  reportPath: string;
  probes: ImportResult[];
  reimport?: SyncResult;
  error?: string;
}

export function dutRecoveryPlan(args: readonly string[], now = new Date()) {
  const dashboardThroughDate = latestClosedBusinessDate(now);
  let throughDate = dashboardThroughDate;
  let startDate: string | undefined;
  let verifyOnly = false;
  const seen = new Set<string>();
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index]!;
    if (seen.has(flag)) throw new Error("重复参数：" + flag);
    seen.add(flag);
    if (flag === "--verify-only") verifyOnly = true;
    else if (["--start-date", "--through-date"].includes(flag) && args[index + 1]) {
      const value = args[++index]!;
      assertDate(value);
      if (flag === "--start-date") startDate = value;
      else throughDate = value;
    } else throw new Error("用法：npm run data:repair-dut -- [--start-date YYYY-MM-DD] [--through-date YYYY-MM-DD] [--verify-only]");
  }
  startDate ??= addDays(throughDate, -29);
  if (startDate > throughDate || throughDate > dashboardThroughDate) {
    throw new Error("恢复范围必须为已结束的业务日闭区间");
  }
  return { startDate, throughDate, verifyOnly, dashboardThroughDate };
}

async function snapshot(sourcePath: string, destinationPath: string, logger: AppLogger): Promise<void> {
  const database = new DatabaseSync(sourcePath, { readOnly: true, timeout: 5_000 });
  let lastProgress = 0;
  try {
    await backup(database, destinationPath, { rate: 4096, progress(progress) {
      if (Date.now() - lastProgress >= 5_000 || progress.remainingPages === 0) {
        lastProgress = Date.now();
        logger.info("dut.recovery.backup_progress", { destinationPath, ...progress });
      }
    } });
  } finally { database.close(); }
}

/** Production is opened for writes only after all probes pass on a separate copy. */
export async function recoverDut(options: DutRecoveryOptions, logger: AppLogger): Promise<DutRecoveryResult> {
  assertDate(options.startDate); assertDate(options.throughDate);
  if (options.startDate > options.throughDate) throw new Error("恢复起始日不能晚于截止日");
  await mkdir(options.backupDirectory, { recursive: true, mode: 0o700 });
  const directory = await mkdtemp(path.join(options.backupDirectory, "dut-repair-"));
  const result: DutRecoveryResult = {
    status: "failed", stage: "backup", productionChanged: false,
    startDate: options.startDate, throughDate: options.throughDate,
    backupPath: path.join(directory, "oee-before.sqlite"),
    verificationPath: path.join(directory, "oee-verification.sqlite"),
    reportPath: path.join(directory, "report.json"), probes: [],
  };
  const saveReport = () => writeFile(result.reportPath, JSON.stringify(result, null, 2) + "\n", { mode: 0o600 });
  let store: OeeDataStore | undefined;
  try {
    await snapshot(options.databasePath, result.backupPath, logger);
    await snapshot(result.backupPath, result.verificationPath, logger);
    initializeOeeDatabase(result.verificationPath);
    result.stage = "verification";
    await saveReport();
    store = OeeDataStore.open({ ...options, databasePath: result.verificationPath, logger });
    const historical = options.throughDate.slice(0, 4) + "-10-05";
    const anchor = historical >= options.startDate && historical <= options.throughDate ? historical : options.startDate;
    const probeDates = [...new Set([anchor, addDays(anchor, 1), options.throughDate])]
      .filter((date) => date >= options.startDate && date <= options.throughDate);
    for (const date of probeDates) {
      const probe = await store.pullWindow({ dataset: "dut_utilization", startDate: date, endDate: date });
      result.probes.push(probe);
      await saveReport();
      if (probe.status !== "completed" || !probe.committedDates.includes(date) ||
          !["day", "night"].every((shift) => probe.validation.some((summary) => summary.shift === shift && summary.rowCount > 0))) {
        throw new Error(date + " 的完整业务日覆盖核验未通过；生产数据未重导");
      }
      logger.info("dut.recovery.probe_verified", { date, validation: probe.validation, sourceSha256: probe.sourceSha256 });
    }
    store.close(); store = undefined;
    if (options.verifyOnly) {
      result.stage = "verified"; result.status = "completed";
      return result;
    }
    // The pristine backup is retained; migrations and probes never modify it.
    initializeOeeDatabase(options.databasePath);
    result.productionChanged = true;
    result.stage = "reimport";
    await saveReport();
    store = OeeDataStore.open({ ...options, logger });
    result.reimport = await store.reimport({ dataset: "dut_utilization", startDate: options.startDate, endDate: options.throughDate });
    result.status = result.reimport.status;
    result.stage = "completed";
    return result;
  } catch (error) {
    result.error = error instanceof Error ? error.message : String(error);
    logger.error("dut.recovery.failed", error, { stage: result.stage, productionChanged: result.productionChanged });
    return result;
  } finally {
    store?.close();
    await saveReport();
  }
}
