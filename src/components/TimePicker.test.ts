import { describe, expect, it } from "vitest";
import { inAnHour, parseTimeInput } from "./TimePicker";

describe("typing a time", () => {
  it("understands the usual ways of writing it", () => {
    const cases: [string, string | null][] = [
      ["9", "09:00"],
      ["3", "15:00"],
      ["9am", "09:00"],
      ["9 AM", "09:00"],
      ["10:30pm", "22:30"],
      ["10:30 pm", "22:30"],
      ["930", "09:30"],
      ["9.30p", "21:30"],
      ["21:15", "21:15"],
      ["12am", "00:00"],
      ["12pm", "12:00"],
      ["noon", "12:00"],
      ["midnight", "00:00"],
      ["7", "07:00"],
      ["25", null],
      ["13pm", null],
      ["9:75", null],
      ["soon", null],
      ["", null],
    ];
    for (const [text, want] of cases) expect(parseTimeInput(text), text).toBe(want);
  });

  it("rounds an hour from now up to a quarter hour", () => {
    expect(inAnHour(new Date(2026, 9, 25, 14, 5))).toBe("15:15");
    expect(inAnHour(new Date(2026, 9, 25, 14, 0))).toBe("15:00");
  });
});
