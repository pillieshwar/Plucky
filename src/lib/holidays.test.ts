import { describe, expect, it } from "vitest";
import { holidaysByDay, isHolidayCalendar } from "./holidays";
import type { CalendarEvent } from "./types";

const ev = (title: string, start: string, end: string, calendar = "US Holidays", all_day = true): CalendarEvent => ({
  id: title,
  title,
  start,
  end,
  all_day,
  calendar,
  color: null,
});

describe("holidays", () => {
  it("recognises holiday calendars", () => {
    expect(isHolidayCalendar("US Holidays")).toBe(true);
    expect(isHolidayCalendar("Holidays in United States")).toBe(true);
    expect(isHolidayCalendar("Feiertage in Deutschland")).toBe(true);
    expect(isHolidayCalendar("Work")).toBe(false);
  });

  it("marks each day of an all-day holiday, not the day after", () => {
    const days = holidaysByDay(
      [
        ev("Christmas Day", "2026-12-25T00:00:00", "2026-12-26T00:00:00"),
        ev("Winter break", "2026-12-28T00:00:00", "2026-12-31T00:00:00"),
        ev("Standup", "2026-12-25T09:00:00", "2026-12-25T09:15:00", "Work", false),
      ],
      "2026-12-20",
      "2026-12-29",
    );
    expect(days.get("2026-12-25")).toEqual(["Christmas Day"]);
    expect(days.has("2026-12-26")).toBe(false);
    expect(days.get("2026-12-29")).toEqual(["Winter break"]);
    // Outside the range.
    expect(days.has("2026-12-30")).toBe(false);
  });
});
