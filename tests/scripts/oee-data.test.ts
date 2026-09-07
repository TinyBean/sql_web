import assert from "node:assert/strict";
import { createServer } from "node:http";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { initializeOeeDatabase } from "../../scripts/database/initialize.ts";
import { OeeDataStore, outcomeExitCode } from "../../scripts/database/oee-data-store.ts";
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

test("maps completed, warning, and failed outcomes to scheduler-friendly exit codes", () => {
  assert.equal(outcomeExitCode("completed"), 0);
  assert.equal(outcomeExitCode("completed_with_warnings"), 2);
  assert.equal(outcomeExitCode("failed"), 1);
});

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
  assert.deepEqual(synced.datasets[0]?.plannedWindows, [
    { startDate: "2026-08-21", endDate: "2026-08-23" },
    { startDate: "2026-08-24", endDate: "2026-08-24" },
  ]);
  assert.equal(requestedUrls.length, 2);
  assert.equal(requestedUrls[0]?.searchParams.get("pSTARTDAY"), "20260821");
  assert.equal(requestedUrls[0]?.searchParams.get("pENDDAY"), "20260823");
  assert.equal(requestedUrls[1]?.searchParams.get("pSTARTDAY"), "20260824");
  assert.equal(requestedUrls[1]?.searchParams.get("pENDDAY"), "20260824");
  const status = store.getStatus()[0];
  assert.equal(status?.facts.rowCount, 6);
  assert.equal(status?.facts.minDataDate, "2026-08-20");
  assert.equal(status?.facts.maxDataDate, "2026-08-24");

  const logEntries = readFileSync(logFilePath, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as { event: string });
  assert.ok(logEntries.some((entry) => entry.event === "oee.run.started"));
  assert.ok(logEntries.some((entry) => entry.event === "oee.window.started"));
  assert.ok(logEntries.some((entry) => entry.event === "oee.window.completed"));
  assert.equal(logEntries.at(-1)?.event, "oee.sync.completed");
});

test("assigns separate auto-increment IDs to completely identical API rows", async (t) => {
  const directory = mkdtempSync(path.join(tmpdir(), "oee-duplicate-conflict-test-"));
  const sourcePath = path.join(directory, "conflict.json");
  writeFileSync(sourcePath, availabilityResponse([
    availabilityRow("2026-08-20", "conflict", 60),
    availabilityRow("2026-08-20", "conflict", 60),
  ]));
  const store = createStore(directory);
  let reader: DatabaseSync | undefined;
  t.after(() => {
    reader?.close();
    store.close();
    rmSync(directory, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 50,
    });
  });

  const result = await store.importFile({
    dataset: "availability",
    filePath: sourcePath,
    requestedStartDate: "2026-08-20",
    requestedEndDate: "2026-08-20",
  });
  assert.equal(result.rowsReceived, 2);
  assert.equal(result.rowsInserted, 2);

  reader = new DatabaseSync(path.join(directory, "oee.sqlite"), { readOnly: true });
  assert.deepEqual(
    reader.prepare("SELECT id, time_span FROM oee_availability ORDER BY id").all()
      .map((row) => ({ ...row })),
    [{ id: 1, time_span: 60 }, { id: 2, time_span: 60 }],
  );
});

test("atomically replaces returned dates while preserving duplicate rows within one response", async (t) => {
  const directory = mkdtempSync(path.join(tmpdir(), "oee-replace-test-"));
  const sourcePath = path.join(directory, "replace.json");
  const store = createStore(directory);
  let reader: DatabaseSync | undefined;
  t.after(() => {
    reader?.close();
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });

  writeFileSync(sourcePath, availabilityResponse([
    availabilityRow("2026-08-20", "first", 60),
    availabilityRow("2026-08-20", "first", 60),
  ]));
  const first = await store.importFile({
    dataset: "availability",
    filePath: sourcePath,
    requestedStartDate: "2026-08-20",
    requestedEndDate: "2026-08-20",
  });
  assert.equal(first.status, "completed");
  assert.equal(first.rowsDeleted, 0);

  writeFileSync(sourcePath, availabilityResponse([
    availabilityRow("2026-08-20", "replacement", 120),
  ]));
  const second = await store.importFile({
    dataset: "availability",
    filePath: sourcePath,
    requestedStartDate: "2026-08-20",
    requestedEndDate: "2026-08-20",
  });
  assert.equal(second.rowsDeleted, 2);
  reader = new DatabaseSync(path.join(directory, "oee.sqlite"), { readOnly: true });
  assert.deepEqual(
    reader.prepare("SELECT tool_name, time_span FROM oee_availability").all().map((row) => ({ ...row })),
    [{ tool_name: "TOOL-replacement", time_span: 120 }],
  );
  assert.equal(reader.prepare("SELECT COUNT(*) AS count FROM oee_import_runs").get()?.["count"], 2);
});

test("preserves old rows for missing response dates and recommends a reimport", async (t) => {
  const directory = mkdtempSync(path.join(tmpdir(), "oee-missing-day-test-"));
  const sourcePath = path.join(directory, "missing.json");
  const store = createStore(directory);
  let reader: DatabaseSync | undefined;
  t.after(() => {
    reader?.close();
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });

  writeFileSync(sourcePath, availabilityResponse([
    availabilityRow("2026-08-20", "old-20", 20),
    availabilityRow("2026-08-21", "old-21", 21),
  ]));
  await store.importFile({
    dataset: "availability",
    filePath: sourcePath,
    requestedStartDate: "2026-08-20",
    requestedEndDate: "2026-08-21",
  });
  writeFileSync(sourcePath, availabilityResponse([
    availabilityRow("2026-08-20", "new-20", 120),
  ]));
  const result = await store.importFile({
    dataset: "availability",
    filePath: sourcePath,
    requestedStartDate: "2026-08-20",
    requestedEndDate: "2026-08-21",
  });
  assert.equal(result.status, "completed_with_warnings");
  assert.deepEqual(result.missingDates, ["2026-08-21"]);

  reader = new DatabaseSync(path.join(directory, "oee.sqlite"), { readOnly: true });
  assert.deepEqual(
    reader.prepare("SELECT tool_name, time_span FROM oee_availability ORDER BY date").all()
      .map((row) => ({ ...row })),
    [
      { tool_name: "TOOL-new-20", time_span: 120 },
      { tool_name: "TOOL-old-21", time_span: 21 },
    ],
  );
  const status = store.getStatus()[0];
  assert.deepEqual(status?.issues[0]?.missingDates, ["2026-08-21"]);
  assert.equal(status?.recommendations.some((item) => item.action === "reimport"), true);
});

test("imports DUT rows with missing or unexpected dates and exposes their non-idempotent status", async (t) => {
  const directory = mkdtempSync(path.join(tmpdir(), "oee-dut-anomaly-test-"));
  const sourcePath = path.join(directory, "dut-anomaly.json");
  const normal = dutRow("normal");
  const undated = dutRow("undated");
  undated["ORPTSIP.DATE"] = null;
  const unexpected = dutRow("unexpected");
  unexpected["ORPTSIP.DATE"] = "2026-08-18T00:00:00.000Z";
  writeFileSync(sourcePath, dutResponse([normal, undated, unexpected]));
  const store = createStore(directory);
  t.after(() => {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });

  const first = await store.importFile({
    dataset: "dut_utilization",
    filePath: sourcePath,
    requestedStartDate: "2026-08-20",
    requestedEndDate: "2026-08-20",
  });
  assert.equal(first.status, "completed_with_warnings");
  assert.equal(first.unscopedRowCount, 1);
  assert.deepEqual(first.unexpectedDates, ["2026-08-18"]);
  assert.deepEqual(first.missingDates, []);

  await store.importFile({
    dataset: "dut_utilization",
    filePath: sourcePath,
    requestedStartDate: "2026-08-20",
    requestedEndDate: "2026-08-20",
  });
  const status = store.getStatus()[1];
  assert.equal(status?.facts.rowCount, 5);
  assert.equal(status?.facts.unscopedRowCount, 2);
});

test("marks abandoned audit runs as interrupted when their owner process is gone", (t) => {
  const directory = mkdtempSync(path.join(tmpdir(), "oee-recovery-test-"));
  const databasePath = path.join(directory, "oee.sqlite");
  initializeOeeDatabase(databasePath);
  const writer = new DatabaseSync(databasePath);
  writer.prepare(
    `INSERT INTO oee_import_runs
       (id, command, parameters_json, status, owner_pid, started_at)
     VALUES ('abandoned-run', 'sync', '{}', 'running', 999999999, '2026-08-20T00:00:00+08:00')`,
  ).run();
  writer.prepare(
    `INSERT INTO oee_import_windows (
       id, run_id, sequence, dataset, source_kind, source_ref,
       requested_start_date, requested_end_date, expected_start_date, expected_end_date, status
     ) VALUES (
       'abandoned-window', 'abandoned-run', 0, 'availability', 'api', 'test',
       '2026-08-20', '2026-08-22', '2026-08-20', '2026-08-22', 'downloading'
     )`,
  ).run();
  writer.close();
  const store = OeeDataStore.open({ databasePath });
  t.after(() => {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const status = store.getStatus()[0];
  assert.equal(status?.issues[0]?.status, "interrupted");
  assert.deepEqual(status?.tracking.unresolvedRanges, [{
    startDate: "2026-08-20",
    endDate: "2026-08-22",
  }]);
});

test("labels pre-audit facts as legacy data", (t) => {
  const directory = mkdtempSync(path.join(tmpdir(), "oee-legacy-status-test-"));
  const databasePath = path.join(directory, "oee.sqlite");
  initializeOeeDatabase(databasePath);
  const writer = new DatabaseSync(databasePath);
  writer.prepare(
    `INSERT INTO oee_availability
       (tool_name, lot_id, final_state, step, date, shift, time_span)
     VALUES ('TOOL-1', 'LOT-1', 'Running', '1000', '2026-08-20T00:00:00Z', NULL, 60)`,
  ).run();
  writer.close();
  const store = OeeDataStore.open({ databasePath });
  t.after(() => {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const status = store.getStatus()[0];
  assert.equal(status?.tracking.state, "legacy_untracked");
  assert.equal(status?.tracking.nextStartDate, "2026-08-21");
  assert.equal(status?.recommendations[0]?.action, "reimport");
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

test("reimports a warning range and closes the active issue", async (t) => {
  const directory = mkdtempSync(path.join(tmpdir(), "oee-reimport-test-"));
  let complete = false;
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    const dates = requestedDateKeys(url);
    const returnedDates = complete ? dates : dates.slice(0, 1);
    response.writeHead(200, { "content-type": "application/json" });
    response.end(availabilityResponse(
      returnedDates.map((date) => availabilityRow(date, complete ? "complete" : "partial")),
    ));
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

  const partial = await store.pullWindow({
    dataset: "availability",
    startDate: "2026-08-20",
    endDate: "2026-08-21",
  });
  assert.equal(partial.status, "completed_with_warnings");
  assert.equal(store.getStatus()[0]?.issues.length, 1);

  complete = true;
  const repaired = await store.reimport({
    dataset: "availability",
    startDate: "2026-08-20",
    endDate: "2026-08-21",
  });
  assert.equal(repaired.status, "completed");
  const status = store.getStatus()[0];
  assert.equal(status?.issues.length, 0);
  assert.equal(status?.facts.rowCount, 2);
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
  assert.equal(store.getStatus()[0]?.facts.rowCount, 0);
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
    if (dates[0] === "2026-08-21" && !failedWindowOnce) {
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
  const failed = await store.sync(syncOptions);
  assert.equal(failed.status, "failed");
  assert.deepEqual(requestedWindows, [
    ["2026-08-17", "2026-08-18", "2026-08-19"],
    ["2026-08-21", "2026-08-22", "2026-08-23"],
    ["2026-08-24"],
  ]);

  const resumed = await store.sync(syncOptions);
  assert.deepEqual(resumed.datasets[0]?.plannedWindows, [
    { startDate: "2026-08-21", endDate: "2026-08-23" },
    { startDate: "2026-08-24", endDate: "2026-08-24" },
  ]);
  assert.deepEqual(requestedWindows, [
    ["2026-08-17", "2026-08-18", "2026-08-19"],
    ["2026-08-21", "2026-08-22", "2026-08-23"],
    ["2026-08-24"],
    ["2026-08-21", "2026-08-22", "2026-08-23"],
    ["2026-08-24"],
  ]);
  const status = store.getStatus()[0];
  assert.equal(status?.facts.minDataDate, "2026-08-17");
  assert.equal(status?.facts.maxDataDate, "2026-08-24");
  assert.equal(status?.facts.distinctDateCount, 8);
  assert.equal(status?.facts.rowCount, 8);
});

test("continues a healthy dataset when another dataset cannot be planned", async (t) => {
  const directory = mkdtempSync(path.join(tmpdir(), "oee-partial-planning-test-"));
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    const rows = requestedDateKeys(url).map((date) => availabilityRow(date, date));
    response.writeHead(200, { "content-type": "application/json" });
    response.end(availabilityResponse(rows));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const store = createStore(directory, `http://127.0.0.1:${address.port}/`);
  const writer = new DatabaseSync(path.join(directory, "oee.sqlite"));
  writer.prepare(
    `INSERT INTO oee_availability
       (tool_name, lot_id, final_state, step, date, shift, time_span)
     VALUES ('TOOL-1', 'LOT-1', 'Running', '1000', '2026-08-20T00:00:00Z', NULL, 60)`,
  ).run();
  writer.close();
  t.after(async () => {
    store.close();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
    rmSync(directory, { recursive: true, force: true });
  });

  const result = await store.sync({ dataset: "all", throughDate: "2026-08-21" });
  assert.equal(result.status, "failed");
  assert.equal(result.datasets[0]?.imports[0]?.status, "completed");
  assert.match(result.datasets[1]?.planningError?.message ?? "", /首次同步必须提供/u);
  assert.equal(store.getStatus()[0]?.facts.maxDataDate, "2026-08-21");
  assert.equal(store.getStatus()[1]?.tracking.latestRun?.status, "failed");
  assert.match(store.getStatus()[1]?.tracking.latestRun?.errorMessage ?? "", /首次同步必须提供/u);
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
  let reader: DatabaseSync | undefined;
  t.after(() => {
    reader?.close();
    store.close();
    rmSync(directory, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 50,
    });
  });

  const result = await store.importFile({
    dataset: "dut_utilization",
    filePath: sourcePath,
    requestedStartDate: "2026-08-20",
    requestedEndDate: "2026-08-20",
  });
  assert.equal(result.rowsInserted, 2);
  assert.equal(result.expectedStartDate, "2026-08-19");
  assert.equal(result.expectedEndDate, "2026-08-19");

  reader = new DatabaseSync(path.join(directory, "oee.sqlite"), { readOnly: true });
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
    "oee.run.started",
    "oee.window.started",
    "oee.download.attempt_started",
    "oee.download.failed",
    "oee.window.failed",
    "oee.run.completed",
  ]);
});

test("logs file import failures", async (t) => {
  const directory = mkdtempSync(path.join(tmpdir(), "oee-import-log-test-"));
  const sourcePath = path.join(directory, "invalid.json");
  const logFilePath = path.join(directory, "logs", "oee-data.log");
  writeFileSync(sourcePath, JSON.stringify({ unexpected: [] }));
  const store = createStore(directory, undefined, new FileLogger(logFilePath));
  let reader: DatabaseSync | undefined;
  t.after(() => {
    reader?.close();
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
    "oee.run.started",
    "oee.window.started",
    "oee.window.failed",
    "oee.run.completed",
  ]);
  assert.equal(entries[2]?.level, "ERROR");
  assert.match(entries[2]?.error?.message ?? "", /未能完整读取/u);
  reader = new DatabaseSync(path.join(directory, "oee.sqlite"), { readOnly: true });
  assert.equal(reader.prepare("SELECT COUNT(*) AS count FROM oee_availability").get()?.["count"], 0);
  assert.equal(reader.prepare("SELECT status FROM oee_import_runs").get()?.["status"], "failed");
  assert.equal(reader.prepare("SELECT status FROM oee_import_windows").get()?.["status"], "failed");
});
