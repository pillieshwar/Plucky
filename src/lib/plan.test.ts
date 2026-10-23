import { describe, expect, it } from "vitest";
import { dropPatch, eventsForDay, hourRange, planFor } from "./plan";
import type { CalendarEvent, Task } from "./types";

const TODAY = "2026-10-23";
let id = 0;
const task = (title: string, due: string | null, extra: Partial<Task> = {}): Task => ({
  id: ++id,
  title,
  due_date: due,
  due_time: null,
  recurrence: null,
  source_text: null,
  source_app: null,
  source_bundle: null,
  source_url: null,
  done: false,
  created_at: `2026-10-01T0${id % 10}:00:00Z`,
  created_tz: null,
  completed_at: null,
  snoozed_until: null,
  notified_at: null,
  next_id: null,
  notes: null,
  deadline: null,
  evening: false,
  someday: false,
  project: null,
  heading: null,
  checklist: [],
  series_date: null,
  paused: false,
  ...extra,
});

const event = (title: string, start: string, end: string, all_day = false): CalendarEvent => ({
  id: title,
  title,
  start,
  end,
  all_day,
  calendar: "Work",
  color: null,
});

describe("planFor", () => {
  it("puts timed tasks in their hour and the rest in Anytime", () => {
    const lunch = task("Lunch", TODAY, { due_time: "12:30" });
    const wrap = task("Wrap report", TODAY, { due_time: "12:00" });
    const loose = task("Call bank", TODAY);
    const done = task("Done one", TODAY, { due_time: "12:00", done: true });
    const other = task("Tomorrow", "2026-10-24", { due_time: "12:00" });
    const plan = planFor([lunch, wrap, loose, done, other], TODAY, TODAY);
    expect(plan.byHour.get(12)?.map((t) => t.title)).toEqual(["Wrap report", "Lunch"]);
    expect(plan.anytime.map((t) => t.title)).toEqual(["Call bank"]);
  });

  it("brings overdue tasks to today's Anytime, first", () => {
    const late = task("Late", "2026-10-20", { due_time: "09:00" });
    const loose = task("Loose", TODAY);
    expect(planFor([loose, late], TODAY, TODAY).anytime.map((t) => t.title)).toEqual(["Late", "Loose"]);
    expect(planFor([loose, late], "2026-10-24", TODAY).anytime).toEqual([]);
  });
});

describe("eventsForDay", () => {
  it("places timed, all-day and overnight events", () => {
    const ev = eventsForDay(
      [
        event("Standup", "2026-10-23T09:30:00", "2026-10-23T09:45:00"),
        event("Holiday", "2026-10-23T00:00:00", "2026-10-24T00:00:00", true),
        event("Yesterday's holiday", "2026-10-22T00:00:00", "2026-10-23T00:00:00", true),
        event("Red-eye", "2026-10-22T22:00:00", "2026-10-23T06:00:00"),
        event("Conference", "2026-10-22T09:00:00", "2026-10-24T17:00:00"),
        event("Tomorrow", "2026-10-24T09:00:00", "2026-10-24T10:00:00"),
      ],
      TODAY,
    );
    expect(ev.byHour.get(9)?.map((e) => e.title)).toEqual(["Standup"]);
    expect(ev.byHour.get(0)?.map((e) => e.title)).toEqual(["Red-eye"]);
    expect(ev.allDay.map((e) => e.title)).toEqual(["Holiday", "Conference"]);
  });
});

describe("hourRange", () => {
  it("defaults to 7 AM – 9 PM and widens for early or late items", () => {
    const empty = { byHour: new Map() };
    expect(hourRange({ anytime: [], byHour: new Map() }, { allDay: [], ...empty })).toHaveLength(15);
    const late = planFor([task("Late call", TODAY, { due_time: "23:15" })], TODAY, TODAY);
    const r = hourRange(late, { allDay: [], ...empty });
    expect(r[0]).toBe(7);
    expect(r[r.length - 1]).toBe(23);
  });
});

describe("dropPatch", () => {
  const t = task("Write", TODAY, { due_time: "12:30" });

  it("moves to another hour on the hour", () => {
    expect(dropPatch(t, { iso: TODAY, hour: 15 })).toEqual({ due_time: "15:00" });
  });

  it("keeps the minutes when only the day changes", () => {
    expect(dropPatch(t, { iso: "2026-10-26", hour: 12 })).toEqual({ due_date: "2026-10-26" });
    expect(dropPatch(t, { iso: "2026-10-26" })).toEqual({ due_date: "2026-10-26" });
  });

  it("clears the time when dropped on Anytime", () => {
    expect(dropPatch(t, { iso: TODAY, hour: null })).toEqual({ due_time: null });
  });

  it("dates an undated task", () => {
    expect(dropPatch(task("Idea", null), { iso: TODAY, hour: 9 })).toEqual({ due_date: TODAY, due_time: "09:00" });
  });

  it("moves just one day of a repeating task", () => {
    const r = task("Standup", TODAY, { due_time: "09:00", recurrence: "daily" });
    expect(dropPatch(r, { iso: "2026-10-24" })).toEqual({ due_date: "2026-10-24", only_this: true });
    expect(dropPatch(r, { iso: TODAY, hour: 10 })).toEqual({ due_time: "10:00" });
  });

  it("is a no-op when nothing changes", () => {
    expect(dropPatch(t, { iso: TODAY, hour: 12 })).toBeNull();
    expect(dropPatch(task("Loose", TODAY), { iso: TODAY, hour: null })).toBeNull();
  });
});
