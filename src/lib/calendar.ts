import { addDays, toISODate } from "./dates";

/** One cell of a month view. */
export interface DayCell {
  iso: string;
  day: number;
  /** False for the leading/trailing days of neighbouring months. */
  inMonth: boolean;
}

/**
 * Six weeks (42 days) covering `month` (0-based) of `year`, starting on
 * `weekStart` (0 = Sunday … 6 = Saturday). A fixed six rows keeps the
 * calendar from changing height as you page through months.
 */
export function monthGrid(year: number, month: number, weekStart: number): DayCell[] {
  const first = new Date(year, month, 1);
  const lead = (first.getDay() - weekStart + 7) % 7;
  const start = addDays(first, -lead);
  return Array.from({ length: 42 }, (_, i) => {
    const d = addDays(start, i);
    return { iso: toISODate(d), day: d.getDate(), inMonth: d.getMonth() === month };
  });
}

/** Move `n` months from (year, month), normalizing the year. */
export function shiftMonth(year: number, month: number, n: number): { year: number; month: number } {
  const d = new Date(year, month + n, 1);
  return { year: d.getFullYear(), month: d.getMonth() };
}

const SUNDAY_FIRST = new Set(["US", "CA", "MX", "BR", "JP", "KR", "TW", "IL", "PH", "IN", "ZA", "SA"]);

/** First day of the week for a locale: 0 = Sunday, 1 = Monday, … */
export function weekStartForLocale(locale: string): number {
  try {
    const loc = new Intl.Locale(locale) as Intl.Locale & {
      getWeekInfo?: () => { firstDay: number };
      weekInfo?: { firstDay: number };
    };
    const info = loc.getWeekInfo?.() ?? loc.weekInfo;
    // Intl uses 1 = Monday … 7 = Sunday.
    if (info && info.firstDay >= 1 && info.firstDay <= 7) return info.firstDay % 7;
    const region = loc.maximize().region ?? "";
    return SUNDAY_FIRST.has(region) ? 0 : 1;
  } catch {
    return 0;
  }
}

/** Narrow weekday headers ("S", "M", …) in display order. */
export function weekdayLabels(locale: string, weekStart: number): string[] {
  const fmt = new Intl.DateTimeFormat(locale, { weekday: "narrow" });
  // 2026-10-04 is a Sunday.
  return Array.from({ length: 7 }, (_, i) => fmt.format(new Date(2026, 9, 4 + ((weekStart + i) % 7))));
}

/** "October 2026" */
export function monthLabel(locale: string, year: number, month: number): string {
  return new Date(year, month, 1).toLocaleDateString(locale, { month: "long", year: "numeric" });
}
