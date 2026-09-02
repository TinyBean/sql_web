import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { OeeDataStore } from "../src/oee-data.ts";

const projectRoot = process.cwd();

function availabilityRow(dataDate: string, suffix: string, timeSpan = 60): Record<string, unknown> {
  return {
    "ORPTSIP.TOOL_NAME": `TOOL-${suffix}`,
    "ORPTSIP.LOT_ID": `LOT-${suffix}`,
    "ORPTSIP.FINAL_STATE": "Running",
    "ORPTSIP.STEP": "1000",
    "ORPTSIP.DATE": `${dataDate}T00:00:00.000Z`,
    "ORPTSIP.SHIFT": "day",
    "ORPTSIP.TIME_SPAN": timeSpan,
  };
}

function availabilityResponse(rows: readonly Record<string, unknown>[]): string {
  return JSON.stringify({
    "ORPTSIP.R_OEE_MT_TOP_AVAILABILITY_2WResponse": {
      "ORPTSIP.R_OEE_MT_TOP_AVAILABILITY_2WResult": { "ORPTSIP.row": rows },
    },
  });
}

function dutRow(longValue: string): Record<string, unknown> {
  return {
    "ORPTSIP.DATE": "2026-08-20T00:00:00.000Z",
    "ORPTSIP.DUT_LOT_MAP": longValue,
    "ORPTSIP.DUT_NUM": "192",
    "ORPTSIP.DUT_OFF_AUTO": 0,
    "ORPTSIP.DUT_OFF_MANUAL": 0,
    "ORPTSIP.END_TIME": "2026-08-20T00:00:09.000Z",
    "ORPTSIP.FLUSH_FLAG": "N",
    "ORPTSIP.FULL_TD_INDEX": 1,
    "ORPTSIP.HANDLER_DUT_OFF": "0".repeat(192),
    "ORPTSIP.HANDLER_DUT_OFF_COUNT": 0,
    "ORPTSIP.HBIN_INFO": longValue,
    "ORPTSIP.IN_QTY": "100",
    "ORPTSIP.LOT_ID": "LOT-1",
    "ORPTSIP.MACHINE_ID": "MACHINE-1",
    "ORPTSIP.MIX_NOMIX": "NO",
    "ORPTSIP.OUT_QTY": "99",
    "ORPTSIP.PACKAGE_SIZE": "13X18",
    "ORPTSIP.PARTIAL_TD": 0,
    "ORPTSIP.PART_NUM": "PART-1",
    "ORPTSIP.SBIN_SOCKET_OFF": longValue,
    "ORPTSIP.SBIN_SOCKET_OFF_COUNT": 0,
    "ORPTSIP.SHIFT": "day",
    "ORPTSIP.START_TIME": "2026-08-20T00:00:10.000Z",
    "ORPTSIP.STEP_CODE": "CFL",
    "ORPTSIP.STEP_ID": "1000",
    "ORPTSIP.TD_SEQ_FORSPC": 1,
    "ORPTSIP.TD_SOCKET_OFF": longValue,
    "ORPTSIP.TD_SOCKET_OFF_COUNT": 0,
    "ORPTSIP.TESTER_DUT_OFF": longValue,
    "ORPTSIP.TESTER_DUT_OFF_COUNT": 0,
    "ORPTSIP.TEST_PROGRAM": "program-1",
    "ORPTSIP.TEST_STAGE": "1st",
    "ORPTSIP.TOOLING": "tooling-1",
    "ORPTSIP.TOTAL_IN": "100",
    "ORPTSIP.TOTAL_OUT": "99",
    "ORPTSIP.TOUCHDOWN_INDEX": "1",
    "ORPTSIP.TRAY_ID": "TRAY-1",
  };
}

function dutResponse(rows: readonly Record<string, unknown>[]): string {
  return JSON.stringify({
    "ORPTSIP.R_OEE_MT_TOP_DUT_UTILIZATION_2WResponse": {
      "ORPTSIP.R_OEE_MT_TOP_DUT_UTILIZATION_2WResult": { "ORPTSIP.row": rows },
    },
  });
}

function createStore(directory: string, apiBaseUrl?: string): OeeDataStore {
  return OeeDataStore.open({
    databasePath: path.join(directory, "oee.sqlite"),
    schemaPath: path.join(projectRoot, "sql", "schema.sql"),
    ...(apiBaseUrl ? { apiBaseUrl } : {}),
    requestTimeoutMs: 5_000,
    fetchRetries: 0,
  });
}

test("imports idempotently, audits missing dates, and syncs gaps with overlap", async (t) => {
  const directory = mkdtempSync(path.join(tmpdir(), "oee-import-test-"));
  const initialPath = path.join(directory, "initial.json");
  const initialRows = [
    availabilityRow("2026-08-20", "20"),
    availabilityRow("2026-08-20", "20"),
    availabilityRow("2026-08-22", "22"),
  ];
  writeFileSync(initialPath, availabilityResponse(initialRows));

  const requestedUrls: URL[] = [];
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    requestedUrls.push(url);
    const rows = [
      availabilityRow("2026-08-21", "21"),
      availabilityRow("2026-08-22", "22"),
      availabilityRow("2026-08-23", "23"),
      availabilityRow("2026-08-24", "24"),
    ];
    response.writeHead(200, { "content-type": "application/json" });
    response.end(availabilityResponse(rows));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const store = createStore(directory, `http://127.0.0.1:${address.port}/`);
  t.after(async () => {
    store.close();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
    rmSync(directory, { recursive: true, force: true });
  });

  const first = await store.importFile({
    dataset: "availability",
    filePath: initialPath,
    requestedStartDate: "2026-08-20",
    requestedEndDate: "2026-08-22",
  });
  assert.equal(first.rowsReceived, 3);
  assert.equal(first.rowsInserted, 2);
  assert.equal(first.duplicateRowsInResponse, 1);
  assert.deepEqual(first.missingDates, ["2026-08-21"]);
  assert.deepEqual(store.getStatus()[0]?.openGaps.map((gap) => gap.dataDate), ["2026-08-21"]);

  const synced = await store.sync({
    dataset: "availability",
    throughDate: "2026-08-24",
  });
  assert.deepEqual(synced[0]?.plannedWindows, [
    { startDate: "2026-08-21", endDate: "2026-08-24" },
  ]);
  assert.equal(requestedUrls.length, 1);
  assert.equal(requestedUrls[0]?.searchParams.get("pSTARTDAY"), "20260821");
  assert.equal(requestedUrls[0]?.searchParams.get("pENDDAY"), "20260824");
  const status = store.getStatus()[0];
  assert.equal(status?.rowCount, 5);
  assert.equal(status?.minDataDate, "2026-08-20");
  assert.equal(status?.maxDataDate, "2026-08-24");
  assert.deepEqual(status?.openGaps, []);
});

test("streams large DUT fields and records reversed timestamps without rejecting the batch", async (t) => {
  const directory = mkdtempSync(path.join(tmpdir(), "oee-dut-test-"));
  const sourcePath = path.join(directory, "dut.json");
  writeFileSync(sourcePath, dutResponse([dutRow("0".repeat(70_000))]));
  const store = createStore(directory);
  t.after(() => {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });

  const result = await store.importFile({
    dataset: "dut_utilization",
    filePath: sourcePath,
    requestedStartDate: "2026-08-20",
    requestedEndDate: "2026-08-20",
  });
  assert.equal(result.rowsInserted, 1);
  assert.equal(result.recordIssueCount, 1);

  const reader = new DatabaseSync(path.join(directory, "oee.sqlite"), { readOnly: true });
  t.after(() => reader.close());
  assert.equal(reader.prepare("SELECT COUNT(*) AS count FROM oee_dut_payload").get()?.["count"], 1);
  const issue = reader.prepare(
    "SELECT issue_code, status FROM oee_record_issues WHERE dataset = 'dut_utilization'",
  ).get();
  assert.deepEqual({ ...issue }, { issue_code: "end_before_start", status: "open" });
  assert.equal(
    reader.prepare("SELECT total_duration_seconds FROM oee_dut_monthly_stats").get()?.["total_duration_seconds"],
    0,
  );
});
