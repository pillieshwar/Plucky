import { addDays, parseISODate, toISODate } from "./dates";
import type { CalendarEvent } from "./types";

/**
 * Holiday calendars by name: Apple's "US Holidays", Google's "Holidays in
 * United States", and the same in a few other languages.
 */
const HOLIDAY = /holiday|feiertag|festivo|férié|feriado|vakantie|festività|祝日|节假日|공휴일/i;

export function isHolidayCalendar(name: string): boolean {
  return HOLIDAY.test(name);
}

/**
 * Holidays per day (`YYYY-MM-DD` → names) between `from` and `to`, inclusive.
 * All-day events end at midnight of the day after, so that day isn't counted.
 */
export function holidaysByDay(events: CalendarEvent[], from: string, to: string): Map<string, string[]> {
  const days = new Map<string, string[]>();
  for (const e of events) {
    if (!isHolidayCalendar(e.calendar)) continue;
    const first = e.start.slice(0, 10);
    let last = e.end.slice(0, 10);
    if (e.all_day || e.end.slice(11, 19) === "00:00:00") {
      if (last > first) last = toISODate(addDays(parseISODate(last), -1));
    }
    if (last < first) last = first;
    for (let d = first; d <= last; d = toISODate(addDays(parseISODate(d), 1))) {
      if (d < from || d > to) continue;
      const names = days.get(d) ?? [];
      const name = e.title || "Holiday";
      if (!names.includes(name)) names.push(name);
      days.set(d, names);
    }
  }
  return days;
}
