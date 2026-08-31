import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { DatabaseInputError, DemoDatabase } from "../src/database.js";
import type { QueryResult } from "../src/database.js";

const projectRoot = process.cwd();

function createFixture(t: TestContext): DemoDatabase {
  const directory = mkdtempSync(path.join(tmpdir(), "sqlite-qa-test-"));
  const database = new DemoDatabase({
    filePath: path.join(directory, "demo.sqlite"),
    schemaPath: path.join(projectRoot, "sql", "schema.sql"),
    seedPath: path.join(projectRoot, "sql", "seed.sql"),
  }).initialize();
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

test("initializes the demo schema and seed data", (t) => {
  const database = createFixture(t);
  const result = database.query(
    "SELECT (SELECT COUNT(*) FROM customers) AS customers, (SELECT COUNT(*) FROM orders) AS orders",
  );

  assert.deepEqual(result.columns, ["customers", "orders"]);
  assert.deepEqual(result.rows, [{ customers: 8, orders: 12 }]);
  assert.equal(database.getSchema().some((item) => item.name === "order_details"), true);
});

test("supports positional parameters and enforces the row cap", (t) => {
  const database = createFixture(t);
  const result = database.query(
    "SELECT id, name FROM products WHERE price >= ? ORDER BY price DESC",
    [100],
    { maxRows: 2 },
  );

  assert.equal(result.rowCount, 2);
  assert.equal(result.truncated, true);
  assert.deepEqual(result.rows[0], { id: 4, name: "27 英寸显示器" });
});

test("keeps query_database read-only", (t) => {
  const database = createFixture(t);
  assert.throws(
    () => database.query("DELETE FROM products WHERE id = 1"),
    (error) => error instanceof DatabaseInputError && /只读 SQL/u.test(error.message),
  );
  assert.equal(firstRow(database.query("SELECT COUNT(*) AS count FROM products")).count, 10);
});

test("execute commits allowed writes and rolls back invalid writes", (t) => {
  const database = createFixture(t);
  const result = database.execute("UPDATE products SET stock = stock - ? WHERE id = ?", [2, 1]);
  assert.equal(result.changes, 1);
  assert.equal(firstRow(database.query("SELECT stock FROM products WHERE id = ?", [1])).stock, 34);

  assert.throws(
    () => database.execute("UPDATE products SET stock = -1 WHERE id = 1"),
    /CHECK constraint failed/u,
  );
  assert.equal(firstRow(database.query("SELECT stock FROM products WHERE id = 1")).stock, 34);
});

test("rejects DDL and multiple statements while accepting semicolons in strings", (t) => {
  const database = createFixture(t);
  assert.throws(
    () => database.execute("DROP TABLE products"),
    (error) => error instanceof DatabaseInputError && /只允许/u.test(error.message),
  );
  assert.throws(
    () => database.query("SELECT 1; DELETE FROM products"),
    (error) => error instanceof DatabaseInputError && /一条 SQL/u.test(error.message),
  );
  assert.deepEqual(database.query("SELECT ';' AS value; -- trailing comment").rows, [{ value: ";" }]);
});

test("seed initialization is idempotent and preserves later changes", (t) => {
  const directory = mkdtempSync(path.join(tmpdir(), "sqlite-qa-idempotent-"));
  const options = {
    filePath: path.join(directory, "demo.sqlite"),
    schemaPath: path.join(projectRoot, "sql", "schema.sql"),
    seedPath: path.join(projectRoot, "sql", "seed.sql"),
  };
  const first = new DemoDatabase(options).initialize();
  first.execute("UPDATE products SET stock = ? WHERE id = ?", [31, 1]);
  first.close();
  const second = new DemoDatabase(options).initialize();
  t.after(() => {
    second.close();
    rmSync(directory, { recursive: true, force: true });
  });

  assert.equal(firstRow(second.query("SELECT stock FROM products WHERE id = 1")).stock, 31);
  assert.equal(firstRow(second.query("SELECT COUNT(*) AS count FROM customers")).count, 8);
});
