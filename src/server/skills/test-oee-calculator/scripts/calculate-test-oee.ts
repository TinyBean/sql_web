import { parseArgs } from "node:util";
import { withTestOeeDatabase } from "../database.ts";
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

const result = withTestOeeDatabase(
  (database) => calculateTestOee(
    database,
    startDate,
    endDate,
    kindArgument as TestOeeKindFilter,
  ),
  values.database,
);
console.log(JSON.stringify(result, null, 2));
