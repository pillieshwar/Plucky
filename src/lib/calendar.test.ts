import { describe, expect, it } from "vitest";
import { monthGrid, monthLabel, shiftMonth, weekStartForLocale, weekdayLabels } from "./calendar";

describe("monthGrid", () => {
  it("covers six full weeks starting on Sunday", () => {
    const g = monthGrid(2026, 9, 0); // October 2026; Oct 1 is a Thursday
    expect(g.length).toBe(42);
    expect(g[0]).toEqual({ iso: "2026-09-27", day: 27, inMonth: false });
    expect(g[4]).toEqual({ iso: "2026-10-01", day: 1, inMonth: true });
    expect(g[41].iso).toBe("2026-11-07");
    expect(g.filter((c) => c.inMonth).length).toBe(31);
  });

  it("starts on Monday when asked", () => {
    const g = monthGrid(2026, 9, 1);
    expect(g[0].iso).toBe("2026-09-28");
    expect(g[3].iso).toBe("2026-10-01");
  });

  it("handles a month starting on the week's first day", () => {
    const g = monthGrid(2026, 1, 0); // Feb 1 2026 is a Sunday
    expect(g[0]).toEqual({ iso: "2026-02-01", day: 1, inMonth: true });
  });

  it("crosses DST changes without skipping or repeating days", () => {
    const g = monthGrid(2026, 2, 0); // March 2026
    const isos = g.map((c) => c.iso);
    expect(new Set(isos).size).toBe(42);
    expect(isos).toContain("2026-03-08");
    expect(isos).toContain("2026-03-09");
  });
});

describe("helpers", () => {
  it("shiftMonth wraps years", () => {
    expect(shiftMonth(2026, 11, 1)).toEqual({ year: 2027, month: 0 });
    expect(shiftMonth(2026, 0, -1)).toEqual({ year: 2025, month: 11 });
  });

  it("week start by locale", () => {
    expect(weekStartForLocale("en-US")).toBe(0);
    expect(weekStartForLocale("en-GB")).toBe(1);
    expect(weekStartForLocale("de-DE")).toBe(1);
    expect(weekStartForLocale("not a locale!!")).toBe(0);
  });

  it("labels", () => {
    expect(weekdayLabels("en-US", 0)).toEqual(["S", "M", "T", "W", "T", "F", "S"]);
    expect(weekdayLabels("en-GB", 1)[0]).toBe("M");
    expect(monthLabel("en-US", 2026, 9)).toBe("October 2026");
  });
});
