export interface DatePeriod {
  readonly start: string;
  readonly end: string;
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

export function latestCompleteWeek(throughDate: string): DatePeriod {
  assertDate(throughDate);
  // throughDate is a closed business-day label; include that Saturday when available.
  const daysSinceSaturday = (new Date(throughDate + "T00:00:00.000Z").getUTCDay() + 1) % 7;
  const end = addDays(throughDate, -daysSinceSaturday);
  return { start: addDays(end, -6), end };
}
