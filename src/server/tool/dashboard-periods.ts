export interface DatePeriod {
  readonly start: string;
  readonly end: string;
}

export interface DashboardPeriods {
  readonly year: string;
  readonly trend: DatePeriod;
  readonly week: DatePeriod;
  readonly month: DatePeriod;
  readonly quarter: DatePeriod;
  readonly syncStart: string;
}

export function assertDate(value: string): void {
  const parsed = new Date(value + "T00:00:00.000Z");
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(value) || !Number.isFinite(parsed.getTime()) ||
      parsed.toISOString().slice(0, 10) !== value) {
    throw new Error("无效日期：" + value + "；应为 YYYY-MM-DD");
  }
}

export function addDays(value: string, days: number): string {
  assertDate(value);
  const date = new Date(value + "T00:00:00.000Z");
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

export function latestClosedBusinessDate(now = new Date()): string {
  const local = new Date(now.getTime() + 8 * 60 * 60 * 1000);
  const day = local.toISOString().slice(0, 10);
  return addDays(day, local.getUTCHours() * 60 + local.getUTCMinutes() >= 510 ? -1 : -2);
}

export function dashboardPeriods(throughDate: string): DashboardPeriods {
  assertDate(throughDate);
  const year = throughDate.slice(0, 4);
  const date = new Date(throughDate + "T00:00:00.000Z");
  const weekEnd = addDays(throughDate, -date.getUTCDay());
  const weekStart = addDays(weekEnd, -6);
  const yearStart = year + "-01-01";
  const quarterMonth = Math.floor(date.getUTCMonth() / 3) * 3 + 1;
  return {
    year,
    trend: { start: yearStart, end: throughDate },
    week: { start: weekStart, end: weekEnd },
    month: { start: throughDate.slice(0, 7) + "-01", end: throughDate },
    quarter: { start: year + "-" + String(quarterMonth).padStart(2, "0") + "-01", end: throughDate },
    syncStart: weekStart < yearStart ? weekStart : yearStart,
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
