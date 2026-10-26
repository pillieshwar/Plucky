import { describe, expect, it } from "vitest";
import { snoozePlan } from "./snooze";
import type { Task } from "./types";

const task = (extra: Partial<Task> = {}): Task => ({
  id: 1,
  title: "Send the deck",
  due_date: "2026-10-23",
  due_time: "14:00",
  recurrence: null,
  source_text: null,
  source_app: null,
  source_bundle: null,
  source_url: null,
  done: false,
  created_at: "2026-10-20T10:00:00Z",
  created_tz: null,
  completed_at: null,
  snoozed_until: null,
  notified_at: "2026-10-23T14:00:00",
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

const NOW = new Date(2026, 9, 23, 14, 12, 40); // Fri 2:12 PM

describe("snoozePlan", () => {
  it("1 hour moves the task's time an hour on", () => {
    expect(snoozePlan(task(), "1h", NOW, "en-US").patch).toEqual({ due_date: "2026-10-23", due_time: "15:12" });
  });

  it("15 min and tonight move the time too", () => {
    expect(snoozePlan(task(), "15m", NOW, "en-US").patch.due_time).toBe("14:27");
    expect(snoozePlan(task(), "tonight", NOW, "en-US").patch).toEqual({ due_date: "2026-10-23", due_time: "20:00" });
  });

  it("gives an untimed task a time", () => {
    expect(snoozePlan(task({ due_time: null }), "1h", NOW, "en-US").patch.due_time).toBe("15:12");
  });

  it("an overdue task comes to today", () => {
    expect(snoozePlan(task({ due_date: "2026-10-21" }), "1h", NOW, "en-US").patch.due_date).toBe("2026-10-23");
  });

  it("crosses midnight", () => {
    const late = new Date(2026, 9, 23, 23, 30);
    expect(snoozePlan(task(), "1h", late, "en-US").patch).toEqual({ due_date: "2026-10-24", due_time: "00:30" });
  });

  it("a repeating task keeps its time and is reminded later", () => {
    const p = snoozePlan(task({ recurrence: "daily" }), "1h", NOW, "en-US");
    expect(p.patch).toEqual({ snoozed_until: "2026-10-23T15:12:00" });
  });

  it("tomorrow moves just this one of a repeating task", () => {
    expect(snoozePlan(task({ recurrence: "weekly" }), "tomorrow", NOW, "en-US").patch).toEqual({
      due_date: "2026-10-24",
      snoozed_until: null,
      only_this: true,
    });
  });

  it("tomorrow and next week move the day", () => {
    expect(snoozePlan(task(), "tomorrow", NOW, "en-US").patch).toEqual({ due_date: "2026-10-24", snoozed_until: null });
    expect(snoozePlan(task(), "week", NOW, "en-US").patch.due_date).toBe("2026-10-30");
  });
});
