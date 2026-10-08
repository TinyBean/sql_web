import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test, { type TestContext } from "node:test";
import { addDays } from "../../src/server/database/business-dates.ts";
import type { AppLogger } from "../../src/server/logger.ts";
import { dutRecoveryPlan, recoverDut } from "../../scripts/database/dut-recovery.ts";
import { initializeOeeDatabase } from "../../scripts/database/initialize.ts";

const logger: AppLogger = { info() {}, warn() {}, error() {}, child() { return this; } };

async function fixture(t: TestContext, behavior: "healthy" | "failed" | "partial") {
  const directory = mkdtempSync(path.join(tmpdir(), "dut-recovery-"));
  const databasePath = path.join(directory, "live.sqlite");
  initializeOeeDatabase(databasePath);
  const writer = new DatabaseSync(databasePath);
  writer.exec(`PRAGMA wal_autocheckpoint=0;
    ALTER TABLE oee_import_windows DROP COLUMN coverage_version;
    ALTER TABLE oee_import_windows DROP COLUMN committed_dates_json;
    ALTER TABLE oee_import_windows DROP COLUMN incomplete_dates_json;
    ALTER TABLE oee_import_windows DROP COLUMN ignored_boundary_row_count;
    PRAGMA user_version=2;
    INSERT INTO oee_dut_utilization(machine_id,lot_id,in_qty,out_qty,test_stage,dut_num,step_id,date,shift)
    VALUES('M1','old','10','9','1st','2','5000','2026-10-05T00:00:00.000Z','night');`);
  const requests: string[][] = [];
  const server = createServer((request, response) => {
    if (behavior === "failed") { response.writeHead(500); response.end("unavailable"); return; }
    const url = new URL(request.url ?? "/", "http://localhost");
    const key = (value: string) => value.slice(0, 4) + "-" + value.slice(4, 6) + "-" + value.slice(6, 8);
    const start = key(url.searchParams.get("pSTARTDAY")!);
    const end = key(url.searchParams.get("pENDDAY")!);
    requests.push([start, end]);
    const rows = [];
    for (let date = addDays(start, -1); date <= end; date = addDays(date, 1)) {
      for (const shift of behavior === "partial" ? ["day"] : ["day", "night"]) {
        const endTime = (shift === "day" ? date : addDays(date, 1)) + (shift === "day" ? "T12:00:00.000Z" : "T04:00:00.000Z");
        if (endTime < start + "T00:00:00.000Z" || endTime >= end + "T00:00:00.000Z") continue;
        rows.push({ "ORPTSIP.DATE": date + "T00:00:00.000Z", "ORPTSIP.SHIFT": shift,
          "ORPTSIP.MACHINE_ID": "M1", "ORPTSIP.LOT_ID": date + shift,
          "ORPTSIP.IN_QTY": "100", "ORPTSIP.OUT_QTY": "90", "ORPTSIP.TEST_STAGE": "1st",
          "ORPTSIP.DUT_NUM": "2", "ORPTSIP.STEP_ID": "5000", "ORPTSIP.END_TIME": endTime });
      }
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ "ORPTSIP.R_OEE_MT_TOP_DUT_UTILIZATION_2WResponse": {
      "ORPTSIP.R_OEE_MT_TOP_DUT_UTILIZATION_2WResult": { "ORPTSIP.row": rows },
    } }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  t.after(async () => {
    writer.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(directory, { recursive: true, force: true });
  });
  return { writer, requests, options: { databasePath, backupDirectory: path.join(directory, "backups"),
    startDate: "2026-10-05", throughDate: "2026-10-07", apiBaseUrl: `http://127.0.0.1:${address.port}/`,
    apiUsername: "secret-user", apiPassword: "secret-password", requestTimeoutMs: 1000, fetchRetries: 0 } };
}

test("recovery defaults to the last 30 closed business days and validates CLI arguments", () => {
  const now = new Date("2026-10-08T01:00:00Z");
  assert.deepEqual(dutRecoveryPlan([], now), {
    startDate: "2026-09-08", throughDate: "2026-10-07", verifyOnly: false, dashboardThroughDate: "2026-10-07",
  });
  assert.equal(dutRecoveryPlan(["--verify-only"], now).verifyOnly, true);
  assert.throws(() => dutRecoveryPlan(["--through-date", "2026-10-08"], now), /已结束/u);
  assert.throws(() => dutRecoveryPlan(["--start-date", "2026-10-08"], now), /已结束/u);
  assert.throws(() => dutRecoveryPlan(["--verify-only", "--verify-only"], now), /重复/u);
});

test("an explicit historical repair range preserves the current dashboard cutoff", () => {
  assert.deepEqual(dutRecoveryPlan(["--start-date", "2026-09-05", "--through-date", "2026-09-07"],
    new Date("2026-10-08T01:00:00Z")), {
    startDate: "2026-09-05", throughDate: "2026-09-07", verifyOnly: false, dashboardThroughDate: "2026-10-07",
  });
});

for (const behavior of ["failed", "partial"] as const) {
  test(behavior + " probes retain the WAL snapshot and never migrate or rewrite production", async (t) => {
    const { options, writer } = await fixture(t, behavior);
    const before = writer.prepare("SELECT * FROM oee_dut_utilization").all();
    const result = await recoverDut(options, logger);
    assert.equal(result.status, "failed");
    assert.equal(result.productionChanged, false);
    assert.equal(writer.prepare("PRAGMA user_version").get()?.["user_version"], 2);
    assert.deepEqual(writer.prepare("SELECT * FROM oee_dut_utilization").all(), before);
    const saved = new DatabaseSync(result.backupPath, { readOnly: true });
    assert.equal(saved.prepare("PRAGMA user_version").get()?.["user_version"], 2);
    assert.deepEqual(saved.prepare("SELECT * FROM oee_dut_utilization").all(), before);
    assert.equal(saved.prepare("PRAGMA quick_check").get()?.["quick_check"], "ok");
    saved.close();
    assert.doesNotMatch(readFileSync(result.reportPath, "utf8"), /secret-user|secret-password/u);
  });
}

test("healthy probes permit serial recovery and record per-day source/fact quantity validation", async (t) => {
  const { options, writer, requests } = await fixture(t, "healthy");
  const result = await recoverDut(options, logger);
  assert.equal(result.status, "completed");
  assert.equal(result.productionChanged, true);
  assert.equal(result.stage, "completed");
  assert.equal(writer.prepare("PRAGMA user_version").get()?.["user_version"], 3);
  assert.equal(writer.prepare("SELECT COUNT(*) n FROM oee_dut_utilization").get()?.["n"], 6);
  assert.deepEqual(requests, [["2026-10-05", "2026-10-07"], ["2026-10-06", "2026-10-08"], ["2026-10-07", "2026-10-09"],
    ["2026-10-05", "2026-10-07"], ["2026-10-06", "2026-10-08"], ["2026-10-07", "2026-10-09"]]);
  const saved = new DatabaseSync(result.backupPath, { readOnly: true });
  assert.equal(saved.prepare("PRAGMA user_version").get()?.["user_version"], 2);
  assert.equal(saved.prepare("SELECT lot_id FROM oee_dut_utilization").get()?.["lot_id"], "old");
  saved.close();
  const imports = result.reimport?.datasets[0]?.imports;
  assert.equal(imports?.length, 3);
  for (const item of imports ?? []) {
    assert.notEqual(item.status, "failed");
    if (item.status === "failed") continue;
    assert.deepEqual(item.validation.map(({ shift, rowCount, inQty, outQty, dutNum }) => ({ shift, rowCount, inQty, outQty, dutNum })),
      ["day", "night"].map((shift) => ({ shift, rowCount: 1, inQty: 100, outQty: 90, dutNum: 2 })));
  }
});

test("verify-only keeps successful probes confined to the verification database", async (t) => {
  const { options, writer, requests } = await fixture(t, "healthy");
  const result = await recoverDut({ ...options, verifyOnly: true }, logger);
  assert.equal(result.stage, "verified");
  assert.equal(result.status, "completed");
  assert.equal(result.productionChanged, false);
  assert.equal(writer.prepare("PRAGMA user_version").get()?.["user_version"], 2);
  assert.equal(writer.prepare("SELECT lot_id FROM oee_dut_utilization").get()?.["lot_id"], "old");
  assert.equal(requests.length, 3);
});
