import type { DatabaseSync } from "node:sqlite";
import type { DashboardRow, DashboardTableWidget } from "../../../shared/dashboard.ts";
import { addDays, assertDate, type DatePeriod } from "../../database/business-dates.ts";
import { machinePeriodSql } from "../../skills/test-oee-calculator/assets/machine-metrics.ts";
import { machineLabel, machinePlatform } from "../../skills/test-oee-calculator/assets/machine-platforms.ts";
import { periodLabel } from "./periods.ts";
import { createMachineExtremesTemplate } from "./template.ts";

interface MachineOee {
  readonly machine: string;
  readonly kind: string;
  readonly oee: number | null;
  readonly availabilityDays: number;
  readonly dutDays: number;
}

function queryMachines(database: DatabaseSync, period: DatePeriod): MachineOee[] {
  const rows = database.prepare(machinePeriodSql(period)).all();
  return rows.map((row) => {
    const { machine, kind, oee, availability_days: availabilityDays, dut_days: dutDays } = row;
    if (typeof machine !== "string" || typeof kind !== "string" ||
        typeof availabilityDays !== "number" || typeof dutDays !== "number" ||
        (oee !== null && (typeof oee !== "number" || !Number.isFinite(oee)))) {
      throw new Error("机台 OEE 查询含无效值");
    }
    return { machine, kind, oee, availabilityDays, dutDays };
  });
}

/** Uses the caller's read transaction and the already selected fleet extrema. */
export function buildMachineExtremesTable(
  database: DatabaseSync,
  extremeRows: readonly DashboardRow[],
  range: DatePeriod,
  sourceWarnings: readonly string[] = [],
): DashboardTableWidget {
  assertDate(range.start);
  assertDate(range.end);
  if (range.start > range.end) throw new Error("机台排名开始日期不能晚于结束日期");
  const ranges = new Map<string, DatePeriod>();
  for (let day = range.start; day <= range.end; day = addDays(day, 1)) {
    for (const grain of ["周", "月", "季"] as const) {
      const key = grain + periodLabel(day, grain);
      ranges.set(key, { start: ranges.get(key)?.start ?? day, end: day });
    }
  }
  const cache = new Map<string, MachineOee[]>();
  const warnings = new Set(sourceWarnings);
  const missingPlatforms = new Set<string>();
  const data: DashboardRow[] = [];
  for (const grain of ["周", "月", "季"] as const) {
    for (const pointType of ["最低", "最高"] as const) {
      const row = extremeRows.find((item) => item["grain"] === grain && item["point_type"] === pointType);
      if (!row) continue;
      const period = ranges.get(grain + String(row["period_label"]));
      if (!period) throw new Error("机台排名周期不在看板日期范围内：" + row["period_label"]);
      const key = period.start + "/" + period.end;
      let machines = cache.get(key);
      if (!machines) {
        machines = queryMachines(database, period);
        cache.set(key, machines);
      }
      const calculable = machines.filter((machine) => machine.oee !== null);
      const top = calculable.slice(0, 10);
      data.push({
        grain, point_type: pointType, period_label: row["period_label"] ?? null,
        oee_percent: row["oee_percent"] ?? null,
        top10_machines: top.length ? top.map((machine, index) =>
          `${index + 1}.${machineLabel(machine.machine)}(${machine.kind} ${machine.oee!.toFixed(2)}%)`).join("、") : null,
      });
      for (const machine of top) {
        if (!machinePlatform(machine.machine)) missingPlatforms.add(machine.machine);
      }
      const selectedDays = (Date.parse(period.end) - Date.parse(period.start)) / 86_400_000 + 1;
      const coverage = (column: "availabilityDays" | "dutDays"): string => {
        const days = top.map((machine) => machine[column]);
        return Math.min(...days) + "–" + Math.max(...days) + "/" + selectedDays;
      };
      warnings.add(`${grain} ${row["period_label"]}（${period.start} 至 ${period.end}）：` +
        `可计算机台 ${calculable.length}/${machines.length}，展示 ${top.length} 台；` +
        (top.length ? `入榜机台 Availability 覆盖 ${coverage("availabilityDays")} 天，DUT 覆盖 ${coverage("dutDays")} 天；` : "") +
        "缺失或零分母为 NULL，不参与排名");
    }
  }
  if (missingPlatforms.size) warnings.add(("平台映射待维护 " + missingPlatforms.size + " 台：" +
    [...missingPlatforms].slice(0, 5).map(machineLabel).join("、") + "；请补充机台平台映射").slice(0, 300));
  return {
    ...createMachineExtremesTemplate(),
    subtitle: "与 OEE 极值明细逐项对应的机台 TOP10 list",
    data, warnings: [...warnings],
  };
}
