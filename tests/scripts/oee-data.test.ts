import assert from "node:assert/strict";
import { createServer } from "node:http";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { initializeOeeDatabase } from "../../scripts/database/initialize.ts";
import { OeeDataStore } from "../../scripts/database/oee-data-store.ts";
import type { AppLogger } from "../../src/server/logger.ts";
import { FileLogger } from "../../src/server/logger.ts";

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

function emptyAvailabilityResponse(): string {
  return JSON.stringify({
    "ORPTSIP.R_OEE_MT_TOP_AVAILABILITY_2WResponse": {
      "ORPTSIP.R_OEE_MT_TOP_AVAILABILITY_2WResult": [],
    },
  });
}

function requestedDateKeys(url: URL): string[] {
  const compactStart = url.searchParams.get("pSTARTDAY");
  const compactEnd = url.searchParams.get("pENDDAY");
  assert.ok(compactStart);
  assert.ok(compactEnd);
  const dateKey = (value: string): string =>
    `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}`;
  const startDate = dateKey(compactStart);
  const endDate = dateKey(compactEnd);
  const current = new Date(`${startDate}T00:00:00.000Z`);
  const result: string[] = [];
  while (current.toISOString().slice(0, 10) <= endDate) {
    result.push(current.toISOString().slice(0, 10));
    current.setUTCDate(current.getUTCDate() + 1);
  }
  return result;
}

function dutRow(longValue: string): Record<string, unknown> {
  return {
    "ORPTSIP.DATE": "2026-08-19T00:00:00.000Z",
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

function createStore(
  directory: string,
  apiBaseUrl?: string,
  logger?: AppLogger,
  apiCredentials?: { readonly apiUsername: string; readonly apiPassword: string },
): OeeDataStore {
  const databasePath = path.join(directory, "oee.sqlite");
  initializeOeeDatabase(databasePath);
  return OeeDataStore.open({
    databasePath,
    ...(apiBaseUrl ? { apiBaseUrl } : {}),
    ...(logger ? { logger } : {}),
    ...apiCredentials,
    requestTimeoutMs: 5_000,
    fetchRetries: 0,
  });
}

test("requires explicit database initialization", (t) => {
  const directory = mkdtempSync(path.join(tmpdir(), "oee-missing-test-"));
  const databasePath = path.join(directory, "database", "oee.sqlite");
  t.after(() => rmSync(directory, { recursive: true, force: true }));

  assert.throws(() => OeeDataStore.open({ databasePath }), /npm run data:init/u);
  assert.equal(existsSync(databasePath), false);
  assert.equal(existsSync(path.dirname(databasePath)), false);
});

test("preserves every Availability row and syncs from live fact-table coverage", async (t) => {
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
    const rows = requestedDateKeys(url).map((date) => availabilityRow(date, date.slice(-2)));
    response.writeHead(200, { "content-type": "application/json" });
    response.end(availabilityResponse(rows));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const logFilePath = path.join(directory, "logs", "oee-data.log");
  const logger = new FileLogger(logFilePath);
  const store = createStore(directory, `http://127.0.0.1:${address.port}/`, logger);
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
  assert.equal(first.rowsInserted, 3);

  const synced = await store.sync({
    dataset: "availability",
    throughDate: "2026-08-24",
  });
  assert.deepEqual(synced[0]?.plannedWindows, [
    { startDate: "2026-08-21", endDate: "2026-08-23" },
    { startDate: "2026-08-24", endDate: "2026-08-24" },
  ]);
  assert.equal(requestedUrls.length, 2);
  assert.equal(requestedUrls[0]?.searchParams.get("pSTARTDAY"), "20260821");
  assert.equal(requestedUrls[0]?.searchParams.get("pENDDAY"), "20260823");
  assert.equal(requestedUrls[1]?.searchParams.get("pSTARTDAY"), "20260824");
  assert.equal(requestedUrls[1]?.searchParams.get("pENDDAY"), "20260824");
  const status = store.getStatus()[0];
  assert.equal(status?.rowCount, 7);
  assert.equal(status?.minDataDate, "2026-08-20");
  assert.equal(status?.maxDataDate, "2026-08-24");

  const logEntries = readFileSync(logFilePath, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as { event: string });
  assert.deepEqual(logEntries.map((entry) => entry.event), [
    "oee.import.started",
    "oee.import.completed",
    "oee.sync.started",
    "oee.sync.windows_planned",
    "oee.pull.started",
    "oee.download.attempt_started",
    "oee.download.completed",
    "oee.import.started",
    "oee.import.completed",
    "oee.pull.completed",
    "oee.pull.started",
    "oee.download.attempt_started",
    "oee.download.completed",
    "oee.import.started",
    "oee.import.completed",
    "oee.pull.completed",
    "oee.sync.completed",
  ]);
});

test("assigns separate auto-increment IDs to completely identical API rows", async (t) => {
  const directory = mkdtempSync(path.join(tmpdir(), "oee-duplicate-conflict-test-"));
  const sourcePath = path.join(directory, "conflict.json");
  writeFileSync(sourcePath, availabilityResponse([
    availabilityRow("2026-08-20", "conflict", 60),
    availabilityRow("2026-08-20", "conflict", 60),
  ]));
  const store = createStore(directory);
  t.after(() => {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });

  const result = await store.importFile({
    dataset: "availability",
    filePath: sourcePath,
    requestedStartDate: "2026-08-20",
    requestedEndDate: "2026-08-20",
  });
  assert.equal(result.rowsReceived, 2);
  assert.equal(result.rowsInserted, 2);

  const reader = new DatabaseSync(path.join(directory, "oee.sqlite"), { readOnly: true });
  t.after(() => reader.close());
  assert.deepEqual(
    reader.prepare("SELECT id, time_span FROM oee_availability ORDER BY id").all()
      .map((row) => ({ ...row })),
    [{ id: 1, time_span: 60 }, { id: 2, time_span: 60 }],
  );
});

test("limits API pulls to three inclusive dates", async (t) => {
  const directory = mkdtempSync(path.join(tmpdir(), "oee-window-limit-test-"));
  let requestCount = 0;
  let authorization: string | undefined;
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    requestCount += 1;
    authorization = request.headers.authorization;
    const rows = requestedDateKeys(url).map((date) => availabilityRow(date, date));
    response.writeHead(200, { "content-type": "application/json" });
    response.end(availabilityResponse(rows));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const store = createStore(
    directory,
    `http://127.0.0.1:${address.port}/`,
    undefined,
    { apiUsername: "oee-user", apiPassword: "oee-password" },
  );
  t.after(async () => {
    store.close();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
    rmSync(directory, { recursive: true, force: true });
  });

  await store.pullWindow({
    dataset: "availability",
    startDate: "2026-08-20",
    endDate: "2026-08-22",
  });
  await assert.rejects(
    store.pullWindow({
      dataset: "availability",
      startDate: "2026-08-20",
      endDate: "2026-08-23",
    }),
    /不能超过 3 天/u,
  );
  assert.equal(requestCount, 1);
  assert.equal(
    authorization,
    `Basic ${Buffer.from("oee-user:oee-password").toString("base64")}`,
  );
  assert.throws(
    () => OeeDataStore.open({
      databasePath: path.join(directory, "oee.sqlite"),
      apiUsername: "oee-user",
    }),
    /API_USER 和 API_PWD 必须同时配置/u,
  );
});

test("accepts an empty API result array without creating auxiliary records", async (t) => {
  const directory = mkdtempSync(path.join(tmpdir(), "oee-empty-result-test-"));
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(emptyAvailabilityResponse());
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

  const result = await store.pullWindow({
    dataset: "availability",
    startDate: "2026-04-04",
    endDate: "2026-04-06",
  });
  assert.equal(result.rowsReceived, 0);
  assert.equal(result.rowsInserted, 0);
  assert.equal(result.coverage.rowCount, 0);
  assert.equal(store.getStatus()[0]?.rowCount, 0);
});

test("replays an explicit initial range after a failed window", async (t) => {
  const directory = mkdtempSync(path.join(tmpdir(), "oee-backfill-resume-test-"));
  const initialPath = path.join(directory, "initial.json");
  writeFileSync(initialPath, availabilityResponse([
    availabilityRow("2026-08-17", "17"),
    availabilityRow("2026-08-20", "20"),
    availabilityRow("2026-08-22", "22"),
  ]));

  const requestedWindows: string[][] = [];
  let failedWindowOnce = false;
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    const dates = requestedDateKeys(url);
    requestedWindows.push(dates);
    if (dates[0] === "2026-08-20" && !failedWindowOnce) {
      failedWindowOnce = true;
      response.writeHead(500, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "temporary failure" }));
      return;
    }
    const rows = dates.map((date) => availabilityRow(date, date.slice(-2)));
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

  await store.importFile({
    dataset: "availability",
    filePath: initialPath,
    requestedStartDate: "2026-08-20",
    requestedEndDate: "2026-08-22",
  });
  const syncOptions = {
    dataset: "availability" as const,
    initialStartDate: "2026-08-17",
    throughDate: "2026-08-24",
  };
  await assert.rejects(store.sync(syncOptions), /API 返回 HTTP 500/u);
  assert.deepEqual(requestedWindows, [
    ["2026-08-17", "2026-08-18", "2026-08-19"],
    ["2026-08-20", "2026-08-21", "2026-08-22"],
  ]);

  const resumed = await store.sync(syncOptions);
  assert.deepEqual(resumed[0]?.plannedWindows, [
    { startDate: "2026-08-17", endDate: "2026-08-19" },
    { startDate: "2026-08-20", endDate: "2026-08-22" },
    { startDate: "2026-08-23", endDate: "2026-08-24" },
  ]);
  assert.deepEqual(requestedWindows, [
    ["2026-08-17", "2026-08-18", "2026-08-19"],
    ["2026-08-20", "2026-08-21", "2026-08-22"],
    ["2026-08-17", "2026-08-18", "2026-08-19"],
    ["2026-08-20", "2026-08-21", "2026-08-22"],
    ["2026-08-23", "2026-08-24"],
  ]);
  const status = store.getStatus()[0];
  assert.equal(status?.minDataDate, "2026-08-17");
  assert.equal(status?.maxDataDate, "2026-08-24");
  assert.equal(status?.distinctDateCount, 8);
  assert.equal(status?.rowCount, 14);
});

test("keeps DUT payload fields inline and permits nulls in nonessential fields", async (t) => {
  const directory = mkdtempSync(path.join(tmpdir(), "oee-dut-test-"));
  const sourcePath = path.join(directory, "dut.json");
  const sourceRow = dutRow("0".repeat(70_000));
  sourceRow["ORPTSIP.TOOLING"] = null;
  sourceRow["ORPTSIP.TRAY_ID"] = null;
  sourceRow["ORPTSIP.START_TIME"] = null;
  sourceRow["ORPTSIP.END_TIME"] = null;
  sourceRow["ORPTSIP.PART_NUM"] = null;
  writeFileSync(sourcePath, dutResponse([sourceRow, sourceRow]));
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
  assert.equal(result.rowsInserted, 2);

  const reader = new DatabaseSync(path.join(directory, "oee.sqlite"), { readOnly: true });
  t.after(() => reader.close());
  const rows = reader.prepare(
    "SELECT id, length(dut_lot_map) AS payload_length, tooling, tray_id, start_time, end_time, part_num " +
    "FROM oee_dut_utilization ORDER BY id",
  ).all();
  assert.deepEqual(rows.map((row) => ({ ...row })), [1, 2].map((id) => ({
    id,
    payload_length: 70_000,
    tooling: null,
    tray_id: null,
    start_time: null,
    end_time: null,
    part_num: null,
  })));
});

test("logs API download and pull failures", async (t) => {
  const directory = mkdtempSync(path.join(tmpdir(), "oee-pull-log-test-"));
  const server = createServer((_request, response) => {
    response.writeHead(400, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: "bad request" }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const logFilePath = path.join(directory, "logs", "oee-data.log");
  const store = createStore(
    directory,
    `http://127.0.0.1:${address.port}/`,
    new FileLogger(logFilePath),
  );
  t.after(async () => {
    store.close();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
    rmSync(directory, { recursive: true, force: true });
  });

  await assert.rejects(
    store.pullWindow({
      dataset: "availability",
      startDate: "2026-08-20",
      endDate: "2026-08-20",
    }),
    /API 返回 HTTP 400/u,
  );

  const events = readFileSync(logFilePath, "utf8")
    .trim()
    .split("\n")
    .map((line) => (JSON.parse(line) as { event: string }).event);
  assert.deepEqual(events, [
    "oee.pull.started",
    "oee.download.attempt_started",
    "oee.download.failed",
    "oee.pull.failed",
  ]);
});

test("logs file import failures", async (t) => {
  const directory = mkdtempSync(path.join(tmpdir(), "oee-import-log-test-"));
  const sourcePath = path.join(directory, "invalid.json");
  const logFilePath = path.join(directory, "logs", "oee-data.log");
  writeFileSync(sourcePath, JSON.stringify({ unexpected: [] }));
  const store = createStore(directory, undefined, new FileLogger(logFilePath));
  t.after(() => {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });

  await assert.rejects(
    store.importFile({
      dataset: "availability",
      filePath: sourcePath,
      requestedStartDate: "2026-08-20",
      requestedEndDate: "2026-08-20",
    }),
    /未能完整读取/u,
  );

  const entries = readFileSync(logFilePath, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as {
      event: string;
      level: string;
      error?: { message?: string };
    });
  assert.deepEqual(entries.map((entry) => entry.event), [
    "oee.import.started",
    "oee.import.failed",
  ]);
  assert.equal(entries[1]?.level, "ERROR");
  assert.match(entries[1]?.error?.message ?? "", /未能完整读取/u);
});
