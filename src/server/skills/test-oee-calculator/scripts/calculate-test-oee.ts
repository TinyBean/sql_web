import path from "node:path";
import { parseArgs } from "node:util";
import { AppDatabase } from "../../../data/database.ts";
import {
  calculateTestOee,
  type TestOeeKindFilter,
} from "../test-oee-calculator.ts";

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    database: { type: "string", short: "d" },
  },
});
const [startDate, endDate, kindArgument = "all"] = positionals;

if (!startDate || !endDate || !["all", "MT", "ST"].includes(kindArgument)) {
  throw new Error(
    "用法: node --import tsx src/server/skills/test-oee-calculator/scripts/calculate-test-oee.ts " +
      "START_DATE END_DATE [all|MT|ST] [--database PATH]",
  );
}

const projectRoot = path.resolve(import.meta.dirname, "../../../../..");
const databasePath = path.resolve(
  projectRoot,
  values.database ?? process.env["SQL_WEB_DB_PATH"] ?? ".data/database/oee.sqlite",
);
const database = AppDatabase.open({ filePath: databasePath });

try {
  const result = calculateTestOee(
    database,
    startDate,
    endDate,
    kindArgument as TestOeeKindFilter,
  );
  console.log(JSON.stringify(result, null, 2));
} finally {
  database.close();
}
