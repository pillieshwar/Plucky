import { describe, expect, it } from "vitest";
import { dueChip, dueNow, formatLocal, parseLocal } from "./due";
import type { Task } from "./types";

// Wednesday, 14 October 2026, 2:00 pm local time.
const NOW = new Date(2026, 9, 14, 14, 0);

let id = 0;
const task = (extra: Partial<Task> = {}): Task => ({
  id: ++id,
  title: "x",
  due_date: null,
  due_time: null,
  recurrence: null,
  source_text: null,
  source_app: null,
  source_bundle: null,
  source_url: null,
  done: false,
  created_at: "2026-10-01T00:00:00Z",
  created_tz: null,
  completed_at: null,
  snoozed_until: null,
  notified_at: null,
  next_id: null,
  ...extra,
});

const chip = (t: Partial<Task>) => dueChip(task(t), NOW, "en-US");

describe("dueChip", () => {
  it("marks overdue days and times red", () => {
    expect(chip({ due_date: "2026-10-13" })).toEqual({ tone: "overdue", label: "Overdue · yesterday" });
    expect(chip({ due_date: "2026-10-11" })?.label).toBe("Overdue · 3 days");
    expect(chip({ due_date: "2026-10-14", due_time: "13:30" })).toEqual({ tone: "overdue", label: "Overdue · 1:30 PM" });
  });

  it("marks the next two hours amber", () => {
    expect(chip({ due_date: "2026-10-14", due_time: "14:45" })).toEqual({ tone: "soon", label: "2:45 PM · in 45 min" });
    expect(chip({ due_date: "2026-10-14", due_time: "15:30" })?.label).toBe("3:30 PM · in 1 h 30 min");
  });

  it("shows later times calmly and skips all-day tasks", () => {
    expect(chip({ due_date: "2026-10-14", due_time: "18:00" })).toEqual({ tone: "today", label: "6:00 PM" });
    expect(chip({ due_date: "2026-10-16", due_time: "09:00" })).toEqual({ tone: "later", label: "9:00 AM" });
    expect(chip({ due_date: "2026-10-14" })).toBeNull();
    expect(chip({})).toBeNull();
  });

  it("mutes done tasks and shows snoozes", () => {
    expect(chip({ done: true, due_date: "2026-10-14", due_time: "09:00" })).toEqual({ tone: "done", label: "9:00 AM" });
    expect(chip({ due_date: "2026-10-13", snoozed_until: "2026-10-14T14:15:00" })).toEqual({
      tone: "soon",
      label: "Snoozed · 2:15 PM",
    });
  });
});

describe("dueNow", () => {
  it("lists fired reminders that still need an answer", () => {
    const fired = task({ notified_at: "2026-10-14T13:30:00" });
    const snoozed = task({ notified_at: "2026-10-14T13:30:00", snoozed_until: "2026-10-14T14:30:00" });
    const refired = task({ notified_at: "2026-10-14T13:46:00", snoozed_until: "2026-10-14T13:45:00" });
    const old = task({ notified_at: "2026-10-13T08:00:00" });
    const done = task({ notified_at: "2026-10-14T13:30:00", done: true });
    expect(dueNow([fired, snoozed, refired, old, done], NOW).map((t) => t.id)).toEqual([fired.id, refired.id]);
  });

  it("round-trips local timestamps", () => {
    expect(formatLocal(parseLocal("2026-10-14T09:05:00")!)).toBe("2026-10-14T09:05:00");
    expect(parseLocal("nope")).toBeNull();
  });
});
