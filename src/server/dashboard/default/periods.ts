import { assertDate, latestCompleteWeek, type DatePeriod } from "../../database/business-dates.ts";

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
  const firstMonday = (8 - start.getUTCDay()) % 7;
  const ordinal = (Date.parse(day) - Date.parse(yearStart)) / 86_400_000;
  const week = ordinal < firstMonday ? 0 : Math.floor((ordinal - firstMonday) / 7) + 1;
  return day.slice(0, 4) + "-W" + String(week).padStart(2, "0");
}
