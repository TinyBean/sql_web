import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createServer } from "node:http";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test, { type TestContext } from "node:test";
import { initializeOeeDatabase } from "../../scripts/database/initialize.ts";
import { OeeDataStore, outcomeExitCode, type OeeDataStoreOptions, type SyncResult } from "../../scripts/database/oee-data-store.ts";
import { FileLogger } from "../../src/server/logger.ts";
import { addDays } from "../../src/server/database/business-dates.ts";

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

async function fixture(t: TestContext, overrides: Partial<OeeDataStoreOptions> = {}) {
  const directory = mkdtempSync(path.join(tmpdir(), "oee-sync-test-"));
  const databasePath = path.join(directory, "oee.sqlite");
  initializeOeeDatabase(databasePath);
  const requests: Array<{ url: URL; authorization: string | undefined }> = [];
  const reply = {
    status: 200, body: undefined as string | undefined, render: undefined as ((url: URL) => string) | undefined,
  };
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    requests.push({ url, authorization: request.headers.authorization });
    const dates = requestedDateKeys(url);
    const defaultBody = url.pathname.includes("AVAILABILITY")
      ? availabilityResponse(dates.map((date) => availabilityRow(date, date)))
      : dutResponse(dates.flatMap((date) => ["day", "night"].map((shift) => ({
        ...dutRow(date + shift), "ORPTSIP.DATE": date + "T00:00:00.000Z",
        "ORPTSIP.SHIFT": shift, "ORPTSIP.LOT_ID": date + shift,
      }))));
    response.writeHead(reply.status, { "content-type": "application/json" });
    response.end(reply.body ?? reply.render?.(url) ?? defaultBody);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const apiBaseUrl = `http://127.0.0.1:${address.port}/`;
  const logFilePath = path.join(directory, "oee-data.log");
  const store = OeeDataStore.open({
    databasePath, apiBaseUrl, logger: new FileLogger(logFilePath),
    requestTimeoutMs: 5_000, fetchRetries: 0, ...overrides,
  });
  const database = new DatabaseSync(databasePath);
  t.after(async () => {
    database.close();
    store.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(directory, { recursive: true, force: true });
  });
  return {
    directory, databasePath, apiBaseUrl, logFilePath, store, database, requests, reply,
    windows() { return requests.map(({ url }) => {
      const dates = requestedDateKeys(url);
      return [dates[0]!, dates.at(-1)!];
    }); },
  };
}

function importedWindow(result: SyncResult) {
  assert.notEqual(result.status, "failed", JSON.stringify(result));
  const window = result.datasets[0]?.imports[0];
  assert.ok(window);
  assert.ok(window.status !== "failed", JSON.stringify(window));
  return window;
}

function failedWindow(result: SyncResult) {
  assert.equal(result.status, "failed");
  const window = result.datasets[0]?.imports[0];
  assert.ok(window && window.status === "failed");
  return window;
}

const availabilityTarget = {
  dataset: "availability" as const, initialStartDate: "2026-08-20", throughDate: "2026-08-21",
};
const dutTarget = {
  dataset: "dut_utilization" as const, initialStartDate: "2026-10-05", throughDate: "2026-10-05",
};

function logEntries(filePath: string) {
  return readFileSync(filePath, "utf8").trim().split("\n").map((line) => JSON.parse(line) as {
    event: string; level: string; error?: { message?: string };
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

test("first sync requires a start date for empty datasets and then imports both tables", async (t) => {
  const f = await fixture(t);
  const empty = await f.store.sync({ dataset: "all", throughDate: "2026-08-21" });
  assert.equal(empty.status, "failed");
  assert.ok(empty.datasets.every((result) => /首次同步必须提供/u.test(result.planningError?.message ?? "")));
  assert.equal(f.requests.length, 0);
  const result = await f.store.sync({ ...availabilityTarget, dataset: "all" });
  assert.equal(result.status, "completed");
  assert.deepEqual(result.datasets.map(({ dataset }) => dataset), ["availability", "dut_utilization"]);
  assert.equal(f.database.prepare("SELECT COUNT(*) n FROM oee_availability").get()?.["n"], 2);
  assert.equal(f.database.prepare("SELECT COUNT(*) n FROM oee_dut_utilization").get()?.["n"], 4);
  assert.deepEqual(f.windows(), [
    ["2026-08-20", "2026-08-21"], ["2026-08-20", "2026-08-22"], ["2026-08-21", "2026-08-23"],
  ]);
});

test("preserves every Availability row and fills gaps while refreshing recent dates", async (t) => {
  const f = await fixture(t);
  f.reply.body = availabilityResponse([
    availabilityRow("2026-08-20", "20"), availabilityRow("2026-08-20", "20"), availabilityRow("2026-08-22", "22"),
  ]);
  const first = importedWindow(await f.store.sync({ ...availabilityTarget, throughDate: "2026-08-22" }));
  assert.equal(first.rowsReceived, 3);
  assert.equal(first.rowsInserted, 3);
  f.reply.body = undefined;
  const result = await f.store.sync({ dataset: "availability", throughDate: "2026-08-24" });
  assert.equal(result.status, "completed");
  assert.deepEqual(result.datasets[0]?.plannedWindows, [
    { startDate: "2026-08-21", endDate: "2026-08-23" }, { startDate: "2026-08-24", endDate: "2026-08-24" },
  ]);
  assert.deepEqual(f.windows(), [
    ["2026-08-20", "2026-08-22"], ["2026-08-21", "2026-08-23"], ["2026-08-24", "2026-08-24"],
  ]);
  assert.deepEqual({ ...f.database.prepare("SELECT COUNT(*) n, MIN(substr(date,1,10)) first, MAX(substr(date,1,10)) last FROM oee_availability").get() },
    { n: 6, first: "2026-08-20", last: "2026-08-24" });
  const events = logEntries(f.logFilePath).map(({ event }) => event);
  assert.ok(events.includes("oee.run.started"));
  assert.ok(events.includes("oee.window.started"));
  assert.ok(events.includes("oee.window.completed"));
  assert.equal(events.at(-1), "oee.sync.completed");
});

test("assigns separate auto-increment IDs to completely identical API rows", async (t) => {
  const f = await fixture(t);
  f.reply.body = availabilityResponse([
    availabilityRow("2026-08-20", "conflict"), availabilityRow("2026-08-20", "conflict"),
  ]);
  const result = importedWindow(await f.store.sync({ ...availabilityTarget, throughDate: "2026-08-20" }));
  assert.equal(result.rowsReceived, 2);
  assert.equal(result.rowsInserted, 2);
  assert.deepEqual(f.database.prepare("SELECT id, time_span FROM oee_availability ORDER BY id").all().map((row) => ({ ...row })),
    [{ id: 1, time_span: 60 }, { id: 2, time_span: 60 }]);
});

test("atomically replaces returned dates while preserving duplicate rows within one response", async (t) => {
  const f = await fixture(t);
  const target = { ...availabilityTarget, throughDate: "2026-08-20" };
  f.reply.body = availabilityResponse([availabilityRow("2026-08-20", "first"), availabilityRow("2026-08-20", "first")]);
  assert.equal(importedWindow(await f.store.sync(target)).rowsDeleted, 0);
  f.reply.body = availabilityResponse([availabilityRow("2026-08-20", "replacement", 120)]);
  assert.equal(importedWindow(await f.store.sync(target)).rowsDeleted, 2);
  assert.deepEqual(f.database.prepare("SELECT tool_name, time_span FROM oee_availability").all().map((row) => ({ ...row })),
    [{ tool_name: "TOOL-replacement", time_span: 120 }]);
  assert.equal(f.database.prepare("SELECT COUNT(*) n FROM oee_import_runs").get()?.["n"], 2);
});

test("preserves old rows for missing response dates and records missing dates in audit", async (t) => {
  const f = await fixture(t);
  await f.store.sync(availabilityTarget);
  f.reply.body = availabilityResponse([availabilityRow("2026-08-20", "new-20", 120)]);
  const result = importedWindow(await f.store.sync(availabilityTarget));
  assert.equal(result.status, "completed_with_warnings");
  assert.deepEqual(result.missingDates, ["2026-08-21"]);
  assert.deepEqual(f.database.prepare("SELECT tool_name, time_span FROM oee_availability ORDER BY date").all().map((row) => ({ ...row })),
    [{ tool_name: "TOOL-new-20", time_span: 120 }, { tool_name: "TOOL-2026-08-21", time_span: 60 }]);
  assert.deepEqual({ ...f.database.prepare("SELECT status, missing_dates_json, committed_dates_json FROM oee_import_windows WHERE id=?").get(result.windowId) },
    { status: "completed_with_warnings", missing_dates_json: '["2026-08-21"]', committed_dates_json: '["2026-08-20"]' });
});

async function dutApiFixture(t: TestContext, firstDate: string, lastDate: string) {
  const f = await fixture(t);
  const rows: Record<string, unknown>[] = [];
  for (let date = addDays(firstDate, -1); date <= addDays(lastDate, 1); date = addDays(date, 1)) {
    for (const [shift, end] of [["day", date + "T12:00:00.000Z"], ["night", addDays(date, 1) + "T04:00:00.000Z"]]) {
      const row = { ...dutRow(date + shift), "ORPTSIP.DATE": date + "T00:00:00.000Z",
        "ORPTSIP.SHIFT": shift, "ORPTSIP.END_TIME": end, "ORPTSIP.LOT_ID": date + shift };
      rows.push(row);
      if (shift === "day") rows.push(row);
    }
  }
  f.reply.render = (url) => {
    const dates = requestedDateKeys(url);
    const received = rows.filter((row) => String(row["ORPTSIP.END_TIME"]) >= dates[0]! + "T00:00:00.000Z" &&
      String(row["ORPTSIP.END_TIME"]) < dates.at(-1)! + "T00:00:00.000Z");
    return dutResponse(received);
  };
  return f;
}

test("DUT manual sync overlap and same-day reruns keep both shifts and ignore partial boundary days", async (t) => {
  const f = await dutApiFixture(t, "2026-10-05", "2026-10-06");
  const first = importedWindow(await f.store.sync(dutTarget));
  assert.deepEqual(first.committedDates, ["2026-10-05"]);
  assert.equal(first.ignoredBoundaryRowCount, 3);
  const options = { ...dutTarget, throughDate: "2026-10-06" };
  assert.equal((await f.store.sync(options)).status, "completed");
  assert.equal((await f.store.sync(options)).status, "completed");
  assert.deepEqual(f.windows(), [
    ["2026-10-05", "2026-10-07"], ["2026-10-05", "2026-10-07"], ["2026-10-06", "2026-10-08"],
    ["2026-10-05", "2026-10-07"], ["2026-10-06", "2026-10-08"],
  ]);
  assert.deepEqual(f.database.prepare("SELECT substr(date,1,10) date, shift, COUNT(*) n FROM oee_dut_utilization GROUP BY date,shift ORDER BY date,shift")
    .all().map((row) => ({ ...row })), ["2026-10-05", "2026-10-06"].flatMap((date) =>
      [{ date, shift: "day", n: 2 }, { date, shift: "night", n: 1 }]));
});

test("DUT backfill splits business dates with overlapping HTTP windows across a year boundary", async (t) => {
  const f = await dutApiFixture(t, "2026-12-30", "2027-01-02");
  const options = { dataset: "dut_utilization" as const, initialStartDate: "2026-12-30", throughDate: "2027-01-02" };
  assert.equal((await f.store.sync(options)).status, "completed");
  assert.deepEqual(f.windows(), [["2026-12-30", "2027-01-01"], ["2026-12-31", "2027-01-02"],
    ["2027-01-01", "2027-01-03"], ["2027-01-02", "2027-01-04"]]);
  assert.equal(f.database.prepare("SELECT COUNT(*) n FROM oee_dut_utilization").get()?.["n"], 12);
  await f.store.sync(options);
  assert.equal(f.database.prepare("SELECT COUNT(*) n FROM oee_dut_utilization").get()?.["n"], 12);
  assert.deepEqual(f.windows().slice(4), [["2027-01-01", "2027-01-03"], ["2027-01-02", "2027-01-04"]]);
});

test("DUT sync preserves old shifts when coverage regresses and retries the incomplete date", async (t) => {
  const f = await fixture(t);
  await f.store.sync(dutTarget);
  const before = f.database.prepare("SELECT * FROM oee_dut_utilization ORDER BY id").all();
  f.reply.body = dutResponse([{ ...dutRow("partial"), "ORPTSIP.DATE": "2026-10-05T00:00:00.000Z", "ORPTSIP.SHIFT": "night" }]);
  const result = importedWindow(await f.store.sync(dutTarget));
  assert.equal(result.status, "completed_with_warnings");
  assert.deepEqual(result.incompleteDates, ["2026-10-05"]);
  assert.deepEqual(result.committedDates, []);
  assert.equal(result.rowsDeleted, 0);
  assert.equal(result.rowsInserted, 0);
  assert.deepEqual(f.database.prepare("SELECT * FROM oee_dut_utilization ORDER BY id").all(), before);
  f.reply.body = undefined;
  const retry = await f.store.sync({ dataset: "dut_utilization", throughDate: "2026-10-05" });
  assert.equal(retry.status, "completed");
  assert.deepEqual(retry.datasets[0]?.plannedWindows, [{ startDate: "2026-10-05", endDate: "2026-10-05" }]);
  assert.deepEqual(importedWindow(retry).committedDates, ["2026-10-05"]);
});

test("DUT quantity validation rolls back database-side changes to otherwise successful inserts", async (t) => {
  const f = await fixture(t);
  await f.store.sync(dutTarget);
  const before = f.database.prepare("SELECT * FROM oee_dut_utilization ORDER BY id").all();
  f.database.exec(`CREATE TRIGGER change_quantity AFTER INSERT ON oee_dut_utilization
    BEGIN UPDATE oee_dut_utilization SET out_qty='0' WHERE id=NEW.id; END`);
  const failure = failedWindow(await f.store.sync(dutTarget));
  assert.match(failure.errorMessage, /DUT 写入验收失败/u);
  assert.equal(failure.errorStage, "import");
  assert.deepEqual(f.database.prepare("SELECT * FROM oee_dut_utilization ORDER BY id").all(), before);
});

test("a truncated JSON envelope, trailing garbage, bad row or failed write leaves the whole window intact", async (t) => {
  const f = await fixture(t);
  await f.store.sync(availabilityTarget);
  const before = f.database.prepare("SELECT * FROM oee_availability ORDER BY id").all();
  const good = availabilityResponse([availabilityRow("2026-08-20", "new"), availabilityRow("2026-08-21", "new-21")]);
  for (const body of [good.slice(0, -2), good + "garbage", availabilityResponse([
    availabilityRow("2026-08-20", "new"), { ...availabilityRow("2026-08-21", "bad"), "ORPTSIP.TIME_SPAN": "bad" },
  ])]) {
    f.reply.body = body;
    assert.equal(failedWindow(await f.store.sync(availabilityTarget)).errorStage, "import");
    assert.deepEqual(f.database.prepare("SELECT * FROM oee_availability ORDER BY id").all(), before);
  }
  f.database.exec("CREATE TRIGGER reject_second_date BEFORE INSERT ON oee_availability WHEN NEW.tool_name='TOOL-new-21' BEGIN SELECT RAISE(ABORT,'write rejected'); END");
  f.reply.body = good;
  assert.match(failedWindow(await f.store.sync(availabilityTarget)).errorMessage, /write rejected/u);
  assert.deepEqual(f.database.prepare("SELECT * FROM oee_availability ORDER BY id").all(), before);
});

test("audits undated DUT rows and boundary rows without accumulating them in facts", async (t) => {
  const f = await fixture(t);
  const normal = dutRow("normal");
  const undated = { ...dutRow("undated"), "ORPTSIP.DATE": null };
  const boundary = { ...dutRow("boundary"), "ORPTSIP.DATE": "2026-08-18T00:00:00.000Z" };
  f.reply.body = dutResponse([normal, undated, boundary]);
  const options = { dataset: "dut_utilization" as const, initialStartDate: "2026-08-19", throughDate: "2026-08-19" };
  const first = importedWindow(await f.store.sync(options));
  assert.equal(first.status, "completed_with_warnings");
  assert.equal(first.unscopedRowCount, 1);
  assert.deepEqual(first.unexpectedDates, []);
  assert.equal(first.ignoredBoundaryRowCount, 1);
  assert.deepEqual(first.missingDates, []);
  await f.store.sync(options);
  assert.equal(f.database.prepare("SELECT COUNT(*) n FROM oee_dut_utilization").get()?.["n"], 1);
  assert.equal(f.database.prepare("SELECT COUNT(*) n FROM oee_dut_utilization WHERE date IS NULL").get()?.["n"], 0);
});

test("marks abandoned audit runs as interrupted and retries their unfinished window", async (t) => {
  const f = await fixture(t);
  f.store.close();
  f.database.exec(`INSERT INTO oee_import_runs(id,command,parameters_json,status,owner_pid,started_at)
    VALUES('abandoned-run','sync','{}','running',999999999,'2026-08-20T00:00:00+08:00');
    INSERT INTO oee_import_windows(id,run_id,sequence,dataset,source_kind,source_ref,
      requested_start_date,requested_end_date,expected_start_date,expected_end_date,status)
    VALUES('abandoned-window','abandoned-run',0,'availability','api','test',
      '2026-08-20','2026-08-22','2026-08-20','2026-08-22','downloading');`);
  const store = OeeDataStore.open({ databasePath: f.databasePath, apiBaseUrl: f.apiBaseUrl, fetchRetries: 0 });
  try {
    assert.equal(f.database.prepare("SELECT status FROM oee_import_runs WHERE id='abandoned-run'").get()?.["status"], "interrupted");
    assert.equal(f.database.prepare("SELECT status FROM oee_import_windows WHERE id='abandoned-window'").get()?.["status"], "interrupted");
    const result = await store.sync({ dataset: "availability", throughDate: "2026-08-22" });
    assert.equal(result.status, "completed");
    assert.deepEqual(result.datasets[0]?.plannedWindows, [{ startDate: "2026-08-20", endDate: "2026-08-22" }]);
  } finally { store.close(); }
});

test("syncs pre-audit Availability facts from their existing date coverage", async (t) => {
  const f = await fixture(t);
  f.database.exec(`INSERT INTO oee_availability(tool_name,lot_id,final_state,step,date,time_span)
    VALUES('old','old','Running','1000','2026-08-20T00:00:00Z',60);`);
  const result = await f.store.sync({ dataset: "availability", throughDate: "2026-08-21" });
  assert.equal(result.status, "completed");
  assert.deepEqual(f.windows(), [["2026-08-19", "2026-08-21"]]);
  assert.equal(importedWindow(result).coverage.rowCount, 3);
});

test("splits API syncs into at most three inclusive dates and sends Basic authentication only in headers", async (t) => {
  const f = await fixture(t, { apiUsername: "oee-user", apiPassword: "oee-password" });
  assert.equal((await f.store.sync({ ...availabilityTarget, throughDate: "2026-08-23" })).status, "completed");
  assert.deepEqual(f.windows(), [["2026-08-20", "2026-08-22"], ["2026-08-23", "2026-08-23"]]);
  for (const request of f.requests) {
    assert.equal(request.authorization, `Basic ${Buffer.from("oee-user:oee-password").toString("base64")}`);
    assert.ok(!request.url.href.includes("oee-user"));
    assert.ok(!request.url.href.includes("oee-password"));
  }
  assert.ok(!readFileSync(f.logFilePath, "utf8").includes("oee-password"));
  await assert.rejects(f.store.sync({ ...availabilityTarget, maxWindowDays: 4 }), /maxWindowDays/u);
  assert.equal(f.requests.length, 2);
  assert.throws(() => OeeDataStore.open({ databasePath: f.databasePath, apiUsername: "oee-user" }), /API_USER 和 API_PWD 必须同时配置/u);
});

test("sync retries a warning range and records the recovered commit", async (t) => {
  const f = await fixture(t);
  f.reply.body = availabilityResponse([availabilityRow("2026-08-20", "partial")]);
  const partial = importedWindow(await f.store.sync(availabilityTarget));
  assert.equal(partial.status, "completed_with_warnings");
  f.reply.body = undefined;
  const recovered = await f.store.sync(availabilityTarget);
  assert.equal(recovered.status, "completed");
  assert.deepEqual(importedWindow(recovered).committedDates, ["2026-08-20", "2026-08-21"]);
  assert.equal(f.database.prepare("SELECT COUNT(*) n FROM oee_availability").get()?.["n"], 2);
  assert.equal(f.database.prepare("SELECT status FROM oee_import_windows WHERE id=?").get(partial.windowId)?.["status"], "completed_with_warnings");
});

test("accepts an empty API result array and audits the missing dates without creating facts", async (t) => {
  const f = await fixture(t);
  f.reply.body = emptyAvailabilityResponse();
  const result = importedWindow(await f.store.sync({ dataset: "availability", initialStartDate: "2026-04-04", throughDate: "2026-04-06" }));
  assert.equal(result.status, "completed_with_warnings");
  assert.equal(result.rowsReceived, 0);
  assert.equal(result.rowsInserted, 0);
  assert.equal(result.coverage.rowCount, 0);
  assert.deepEqual(result.missingDates, ["2026-04-04", "2026-04-05", "2026-04-06"]);
  assert.equal(f.database.prepare("SELECT COUNT(*) n FROM oee_availability").get()?.["n"], 0);
});

test("replays an explicit initial range after a failed window and keeps later successful windows", async (t) => {
  const f = await fixture(t);
  f.reply.body = availabilityResponse([
    availabilityRow("2026-08-17", "17"), availabilityRow("2026-08-20", "20"), availabilityRow("2026-08-22", "22"),
  ]);
  await f.store.sync({ ...availabilityTarget, throughDate: "2026-08-22" });
  f.reply.body = undefined;
  let failedOnce = false;
  f.reply.render = (url) => {
    const dates = requestedDateKeys(url);
    if (dates[0] === "2026-08-21" && !failedOnce) {
      failedOnce = true;
      return "invalid JSON";
    }
    return availabilityResponse(dates.map((date) => availabilityRow(date, date.slice(-2))));
  };
  const options = { ...availabilityTarget, initialStartDate: "2026-08-17", throughDate: "2026-08-24" };
  const failed = await f.store.sync(options);
  assert.equal(failed.status, "failed");
  assert.deepEqual(failed.datasets[0]?.imports.map(({ status }) => status), ["completed", "failed", "completed"]);
  assert.deepEqual(f.windows().slice(1), [["2026-08-17", "2026-08-19"], ["2026-08-21", "2026-08-23"], ["2026-08-24", "2026-08-24"]]);
  const resumed = await f.store.sync(options);
  assert.equal(resumed.status, "completed");
  assert.deepEqual(resumed.datasets[0]?.plannedWindows, [
    { startDate: "2026-08-21", endDate: "2026-08-23" }, { startDate: "2026-08-24", endDate: "2026-08-24" },
  ]);
  assert.deepEqual({ ...f.database.prepare("SELECT MIN(substr(date,1,10)) first, MAX(substr(date,1,10)) last, COUNT(DISTINCT substr(date,1,10)) days, COUNT(*) n FROM oee_availability").get() },
    { first: "2026-08-17", last: "2026-08-24", days: 8, n: 8 });
});

test("continues a healthy dataset when another dataset cannot be planned", async (t) => {
  const f = await fixture(t);
  f.database.exec(`INSERT INTO oee_availability(tool_name,lot_id,final_state,step,date,time_span)
    VALUES('old','old','Running','1000','2026-08-20T00:00:00Z',60);`);
  const result = await f.store.sync({ dataset: "all", throughDate: "2026-08-21" });
  assert.equal(result.status, "failed");
  assert.equal(result.datasets[0]?.imports[0]?.status, "completed");
  assert.match(result.datasets[1]?.planningError?.message ?? "", /首次同步必须提供/u);
  assert.equal(f.database.prepare("SELECT MAX(substr(date,1,10)) last FROM oee_availability").get()?.["last"], "2026-08-21");
  const audit = f.database.prepare("SELECT status, error_message FROM oee_import_runs WHERE id=?").get(result.runId);
  assert.equal(audit?.["status"], "failed");
  assert.match(String(audit?.["error_message"]), /首次同步必须提供/u);
});

test("keeps DUT payload fields inline and permits nulls in nonessential fields", async (t) => {
  const f = await fixture(t);
  const sourceRow = dutRow("0".repeat(70_000));
  for (const field of ["TOOLING", "TRAY_ID", "START_TIME", "END_TIME", "PART_NUM"]) sourceRow["ORPTSIP." + field] = null;
  f.reply.body = dutResponse([sourceRow, sourceRow]);
  const result = importedWindow(await f.store.sync({ dataset: "dut_utilization", initialStartDate: "2026-08-19", throughDate: "2026-08-19" }));
  assert.equal(result.rowsInserted, 2);
  assert.equal(result.expectedStartDate, "2026-08-19");
  assert.equal(result.expectedEndDate, "2026-08-19");
  assert.deepEqual(f.database.prepare("SELECT id, length(dut_lot_map) payload_length, tooling, tray_id, start_time, end_time, part_num FROM oee_dut_utilization ORDER BY id")
    .all().map((row) => ({ ...row })), [1, 2].map((id) => ({
      id, payload_length: 70_000, tooling: null, tray_id: null, start_time: null, end_time: null, part_num: null,
    })));
});

test("logs API download failures and records failed sync audit", async (t) => {
  const f = await fixture(t);
  f.reply.status = 400;
  const failure = failedWindow(await f.store.sync(availabilityTarget));
  assert.equal(failure.errorStage, "download");
  assert.match(failure.errorMessage, /API 返回 HTTP 400/u);
  assert.deepEqual(logEntries(f.logFilePath).map(({ event }) => event), [
    "oee.run.started", "oee.sync.windows_planned", "oee.window.started", "oee.download.attempt_started",
    "oee.download.failed", "oee.window.failed", "oee.run.completed", "oee.sync.completed",
  ]);
  assert.equal(f.database.prepare("SELECT status FROM oee_import_runs").get()?.["status"], "failed");
});

test("logs malformed API response import failures and preserves failed audit", async (t) => {
  const f = await fixture(t);
  f.reply.body = JSON.stringify({ unexpected: [] });
  assert.match(failedWindow(await f.store.sync(availabilityTarget)).errorMessage, /未能完整读取/u);
  const entries = logEntries(f.logFilePath);
  const error = entries.find(({ event }) => event === "oee.window.failed");
  assert.equal(error?.level, "ERROR");
  assert.match(error?.error?.message ?? "", /未能完整读取/u);
  assert.equal(f.database.prepare("SELECT COUNT(*) n FROM oee_availability").get()?.["n"], 0);
  assert.equal(f.database.prepare("SELECT status FROM oee_import_runs").get()?.["status"], "failed");
  assert.equal(f.database.prepare("SELECT status FROM oee_import_windows").get()?.["status"], "failed");
});

function cli(args: readonly string[], databasePath: string, apiBaseUrl: string) {
  const compiled = import.meta.url.endsWith(".js");
  const entry = fileURLToPath(new URL(compiled ? "../../scripts/oee-data.js" : "../../scripts/oee-data.ts", import.meta.url));
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(process.execPath, [...(compiled ? [] : ["--import", "tsx"]), entry, ...args], {
      env: {
        ...process.env, NODE_NO_WARNINGS: "1", SQL_WEB_DB_PATH: databasePath, OEE_API_BASE_URL: apiBaseUrl,
        API_USER: "test-user", API_PWD: "test-password",
      },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

test("CLI rejects removed commands and invalid arguments before opening the database", async (t) => {
  const f = await fixture(t);
  f.database.exec(`INSERT INTO oee_import_runs(id,command,parameters_json,status,owner_pid,started_at)
    VALUES('untouched','sync','{}','running',999999999,'2026-08-20T00:00:00+08:00');`);
  for (const args of [[], ["import"], ["pull"], ["reimport"], ["status"], ["repair-dut"], ["init", "extra"],
    ["sync"], ["sync", "all"], ["sync", "unknown", "2026-08-21"], ["sync", "all", "2026-02-30"],
    ["sync", "all", "2026-08-21", "bad"], ["sync", "all", "2026-08-21", "2026-08-22"],
    ["sync", "all", "2026-08-21", "2026-08-20", "extra"]]) {
    const result = await cli(args, f.databasePath, f.apiBaseUrl);
    assert.equal(result.code, 1, result.stderr);
    assert.match(result.stderr, /用法|数据集|日期|不能晚于/u);
    assert.equal(f.database.prepare("SELECT status FROM oee_import_runs WHERE id='untouched'").get()?.["status"], "running", args.join(" "));
  }
  assert.equal(f.requests.length, 0);
});

test("CLI init preserves facts and sync supports all datasets, single datasets and warning exits", async (t) => {
  const f = await fixture(t);
  const initialized = await cli(["init"], f.databasePath, f.apiBaseUrl);
  assert.equal(initialized.code, 0, initialized.stderr);
  assert.equal((JSON.parse(initialized.stdout) as { initialized: boolean }).initialized, true);
  const all = await cli(["sync", "all", "2026-08-21", "2026-08-20"], f.databasePath, f.apiBaseUrl);
  assert.equal(all.code, 0, all.stderr);
  assert.equal((JSON.parse(all.stdout) as SyncResult).datasets.length, 2);
  const before = f.database.prepare("SELECT * FROM oee_availability ORDER BY id").all();
  assert.equal((await cli(["init"], f.databasePath, f.apiBaseUrl)).code, 0);
  assert.deepEqual(f.database.prepare("SELECT * FROM oee_availability ORDER BY id").all(), before);
  const single = await cli(["sync", "dut_utilization", "2026-08-21"], f.databasePath, f.apiBaseUrl);
  assert.equal(single.code, 0, single.stderr);
  assert.deepEqual((JSON.parse(single.stdout) as SyncResult).datasets.map(({ dataset }) => dataset), ["dut_utilization"]);
  f.reply.body = emptyAvailabilityResponse();
  const warning = await cli(["sync", "availability", "2026-08-21"], f.databasePath, f.apiBaseUrl);
  assert.equal(warning.code, 2, warning.stderr);
});
