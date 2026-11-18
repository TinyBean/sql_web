// Test-only SQLite function. Signals from inside the aggregate, before SQLite returns a row.
import { writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import "../../src/server/database/query-worker.ts";

const prepare = DatabaseSync.prototype.prepare;
DatabaseSync.prototype.prepare = function (sql) {
  this.function("test_pause", (marker) => {
    writeFileSync(String(marker), String(process.pid));
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 30_000);
    return 1;
  });
  return prepare.call(this, sql);
};
