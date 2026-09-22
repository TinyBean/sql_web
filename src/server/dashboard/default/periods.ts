import { addDays, assertDate, latestCompleteWeek, type DatePeriod } from "../../database/business-dates.ts";

export const PERIOD_KEYS = ["week", "month", "quarter"] as const;
export type PeriodKey = typeof PERIOD_KEYS[number];
export const PERIOD_GRAINS = { week: "周", month: "月", quarter: "季" } as const;

export interface DashboardPeriods {
  readonly year: string;
  readonly trend: DatePeriod;
  readonly week: DatePeriod;
  readonly month: DatePeriod;
  readonly quarter: DatePeriod;
  readonly syncStart: string;
}

export function dashboardPeriods(throughDate: string): DashboardPeriods {
  assertDate(throughDate);
  const year = throughDate.slice(0, 4);
  const date = new Date(throughDate + "T00:00:00.000Z");
  const week = latestCompleteWeek(throughDate);
  const yearStart = year + "-01-01";
  const quarterMonth = Math.floor(date.getUTCMonth() / 3) * 3 + 1;
  return {
    year,
    trend: { start: yearStart, end: throughDate },
    week,
    month: { start: throughDate.slice(0, 7) + "-01", end: throughDate },
    quarter: { start: year + "-" + String(quarterMonth).padStart(2, "0") + "-01", end: throughDate },
    syncStart: week.start < yearStart ? week.start : yearStart,
  };
}

export function weekLabel(day: string): string {
  assertDate(day);
  const yearStart = day.slice(0, 4) + "-01-01";
  const start = new Date(yearStart + "T00:00:00.000Z");
  const firstSunday = (7 - start.getUTCDay()) % 7;
  const ordinal = (Date.parse(day) - Date.parse(yearStart)) / 86_400_000;
  const week = ordinal < firstSunday ? 0 : Math.floor((ordinal - firstSunday) / 7) + 1;
  return day.slice(0, 4) + "-W" + String(week).padStart(2, "0");
}

export function periodLabel(day: string, grain: "周" | "月" | "季"): string {
  if (grain === "周") return weekLabel(day);
  if (grain === "月") return day.slice(0, 7);
  return day.slice(0, 4) + "-Q" + Math.ceil(Number(day.slice(5, 7)) / 3);
}

export function isPartialPeriod(period: DatePeriod, grain: "周" | "月" | "季"): boolean {
  const start = new Date(period.start + "T00:00:00.000Z");
  const nextDay = addDays(period.end, 1);
  if (grain === "周") return start.getUTCDay() !== 0 ||
    (Date.parse(nextDay) - Date.parse(period.start)) / 86_400_000 !== 7;
  if (grain === "月") return period.start.slice(8) !== "01" || nextDay.slice(8) !== "01";
  return !["01-01", "04-01", "07-01", "10-01"].includes(period.start.slice(5)) ||
    !["01-01", "04-01", "07-01", "10-01"].includes(nextDay.slice(5));
}
