import type { DatabaseSync } from "node:sqlite";
import type { DashboardRow } from "../../../shared/dashboard.ts";
import type { DatePeriod } from "../../database/business-dates.ts";
import { getDefaultTestOeeSql } from "../../skills/test-oee-calculator/assets/test-oee-calculator.ts";

export function readDailyOee(database: DatabaseSync, range: DatePeriod): DashboardRow[] {
  return database.prepare(getDefaultTestOeeSql(range.start, range.end).sql).all().map((row) => {
    const output: Record<string, string | number | null> = {};
    for (const [key, value] of Object.entries(row)) {
      if (value !== null && typeof value !== "string" &&
          !(typeof value === "number" && Number.isFinite(value))) {
        throw new Error("默认看板查询含无效值：" + key);
      }
      output[key] = value;
    }
    return output;
  });
}

export function calculable(rows: readonly DashboardRow[]): readonly DashboardRow[] {
  return rows.filter((row) => typeof row["daily_test_oee"] === "number");
}

export function coverageWarnings(rows: readonly DashboardRow[]): string[] {
  const count = calculable(rows).length;
  if (count === rows.length) return [];
  const availabilityMissing = rows.filter((row) => !row["availability_rows"]).length;
  const dutMissing = rows.filter((row) => !row["dut_rows"]).length;
  return [
    "可计算日类型 " + count + "/" + rows.length + "；缺 Availability " +
      availabilityMissing + " 个、缺 DUT " + dutMissing + " 个；缺失或零分母结果为 NULL，平均仅使用可计算值",
  ];
}
