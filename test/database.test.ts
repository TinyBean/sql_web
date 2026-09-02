import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test, { type TestContext } from "node:test";
import { getCurrentTime } from "../src/database-tools.ts";
import { AppDatabase, assertReadOnlyQuery, DatabaseInputError } from "../src/database.ts";
import type { QueryResult } from "../src/database.ts";

const projectRoot = process.cwd();

function createFixture(t: TestContext): AppDatabase {
  const directory = mkdtempSync(path.join(tmpdir(), "sqlite-qa-test-"));
  const database = AppDatabase.open({
    filePath: path.join(directory, "oee.sqlite"),
    schemaPath: path.join(projectRoot, "sql", "schema.sql"),
  });
  t.after(() => {
    database.close();
    rmSync(directory, { recursive: true, force: true });
  });
  return database;
}

function firstRow(result: QueryResult): QueryResult["rows"][number] {
  const row = result.rows[0];
  assert.ok(row, "query should return at least one row");
  return row;
}

test("returns the current time with UTC and local timezone values", () => {
  const instant = new Date("2026-09-02T06:07:08.000Z");
  const result = getCurrentTime(instant);

  assert.equal(result.utc, "2026-09-02T06:07:08.000Z");
  assert.ok(result.local.length > 0);
  assert.ok(result.timezone.length > 0);
});

test("initializes the OEE schema without demo seed data", (t) => {
  const database = createFixture(t);
  const result = database.query(
    "SELECT (SELECT COUNT(*) FROM oee_availability) AS availability, " +
      "(SELECT COUNT(*) FROM oee_dut_utilization) AS dut",
  );

  assert.deepEqual(result.columns, ["availability", "dut"]);
  assert.deepEqual(result.rows, [{ availability: 0, dut: 0 }]);
  assert.equal(database.getSchema().some((item) => item.name === "oee_data_status"), true);
});

test("supports positional parameters and enforces the row cap", (t) => {
  const database = createFixture(t);
  const result = database.query(
    `WITH records(id, name, amount) AS (
       VALUES (1, 'A', 10), (2, 'B', 30), (3, 'C', 20)
     ) SELECT id, name FROM records WHERE amount >= ? ORDER BY amount DESC`,
    [100],
    { maxRows: 2 },
  );

  assert.equal(result.rowCount, 0);
  assert.equal(result.truncated, false);

  const capped = database.query(
    "SELECT value FROM json_each('[1,2,3]') ORDER BY value",
    [],
    { maxRows: 2 },
  );
  assert.equal(capped.rowCount, 2);
  assert.equal(capped.truncated, true);
});

test("keeps SQL execution read-only", (t) => {
  const database = createFixture(t);
  assert.throws(
    () => database.query("DELETE FROM oee_ingestion_runs"),
    (error) => error instanceof DatabaseInputError && /仅允许执行/u.test(error.message),
  );
  assert.throws(
    () => database.query("DELETE FROM oee_ingestion_runs RETURNING id"),
    (error) => error instanceof DatabaseInputError && /仅允许执行/u.test(error.message),
  );
  assert.equal(firstRow(database.query("SELECT COUNT(*) AS count FROM oee_ingestion_runs"))["count"], 0);
});

test("reviews SQL statement types before execution", () => {
  const queries = [
    "SELECT 1",
    "-- leading comment\nWITH rows(value) AS (VALUES (1)) SELECT value FROM rows",
    "WITH RECURSIVE numbers(value) AS (VALUES (1)) SELECT value FROM numbers",
    "VALUES (1), (2)",
    "EXPLAIN SELECT 1",
    "EXPLAIN QUERY PLAN WITH rows(value) AS (VALUES (1)) SELECT value FROM rows",
    "PRAGMA table_info('oee_availability')",
    "PRAGMA main.index_list(oee_availability)",
    "PRAGMA user_version",
  ];
  for (const sql of queries) assert.doesNotThrow(() => assertReadOnlyQuery(sql), sql);

  const nonQueries = [
    "INSERT INTO example VALUES (1)",
    "UPDATE example SET value = 1 RETURNING value",
    "DELETE FROM example RETURNING value",
    "REPLACE INTO example VALUES (1)",
    "WITH rows(value) AS (VALUES (1)) DELETE FROM example RETURNING value",
    "EXPLAIN DELETE FROM example",
    "CREATE TABLE example(value INTEGER)",
    "ALTER TABLE example ADD COLUMN other INTEGER",
    "DROP TABLE example",
    "VACUUM",
    "ATTACH DATABASE 'other.sqlite' AS other",
    "PRAGMA user_version = 1",
    "PRAGMA user_version(1)",
    "PRAGMA foreign_keys = OFF",
  ];
  for (const sql of nonQueries) {
    assert.throws(
      () => assertReadOnlyQuery(sql),
      (error) => error instanceof DatabaseInputError && /仅允许执行/u.test(error.message),
      sql,
    );
  }
});

test("does not expose a writable database operation", (t) => {
  const database = createFixture(t);
  assert.equal("execute" in database, false);
});

test("rejects writes and multiple statements while accepting semicolons in strings", (t) => {
  const database = createFixture(t);
  assert.throws(
    () => database.query("DROP TABLE oee_availability"),
    (error) => error instanceof DatabaseInputError && /仅允许执行/u.test(error.message),
  );
  assert.throws(
    () => database.query("SELECT 1; DELETE FROM oee_availability"),
    (error) => error instanceof DatabaseInputError && /一条 SQL/u.test(error.message),
  );
  assert.deepEqual(database.query("SELECT ';' AS value; -- trailing comment").rows, [{ value: ";" }]);
});

test("schema initialization is idempotent and preserves imported state", (t) => {
  const directory = mkdtempSync(path.join(tmpdir(), "sqlite-qa-idempotent-"));
  const options = {
    filePath: path.join(directory, "oee.sqlite"),
    schemaPath: path.join(projectRoot, "sql", "schema.sql"),
  };
  const first = AppDatabase.open(options);
  first.close();
  const importer = new DatabaseSync(options.filePath);
  importer.prepare(
    `INSERT INTO oee_ingestion_runs (
       dataset, source_kind, source_ref, requested_start_date, requested_end_date, status, started_at
     ) VALUES ('availability', 'file', 'fixture.json', '2026-08-20', '2026-08-20', 'running', '2026-09-02T00:00:00Z')`,
  ).run();
  importer.close();
  const second = AppDatabase.open(options);
  t.after(() => {
    second.close();
    rmSync(directory, { recursive: true, force: true });
  });

  assert.equal(firstRow(second.query("SELECT COUNT(*) AS count FROM oee_ingestion_runs"))["count"], 1);
});
