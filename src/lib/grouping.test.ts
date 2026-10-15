import { describe, expect, it } from "vitest";
import { groupTasks } from "./grouping";
import type { Task } from "./types";

const TUE = new Date(2026, 9, 13, 15, 30);
let nextId = 1;

function task(title: string, due: string | null, extra: Partial<Task> = {}): Task {
  const id = nextId++;
  return {
    id,
    title,
    due_date: due,
    source_text: null,
    done: false,
    created_at: `2026-10-0${(id % 9) + 1}T10:00:00Z`,
    created_tz: "America/Los_Angeles",
    completed_at: null,
    due_time: null,
    recurrence: null,
    source_app: null,
    source_bundle: null,
    source_url: null,
    snoozed_until: null,
    notified_at: null,
    next_id: null,
    notes: null,
    ...extra,
  };
}

describe("groupTasks", () => {
  it("orders overdue, today, future days, someday, done", () => {
    const groups = groupTasks(
      [
        task("later", "2026-10-26"),
        task("someday", null),
        task("friday", "2026-10-16"),
        task("today", "2026-10-13"),
        task("late", "2026-10-10"),
        task("finished", "2026-10-13", { done: true, completed_at: "2026-10-13T18:00:00Z" }),
        task("tomorrow", "2026-10-14"),
      ],
      TUE,
      "en-US",
    );
    expect(groups.map((g) => g.label)).toEqual(["Overdue", "Today", "Tomorrow", "Friday", "Mon, Oct 26", "No date", "Done"]);
    expect(groups.map((g) => g.tone)).toEqual(["overdue", "today", "upcoming", "upcoming", "upcoming", "someday", "done"]);
  });

  it("groups multiple tasks on one day in creation order", () => {
    const a = task("a", "2026-10-16", { created_at: "2026-10-02T00:00:00Z" });
    const b = task("b", "2026-10-16", { created_at: "2026-10-01T00:00:00Z" });
    const [g] = groupTasks([a, b], TUE, "en-US");
    expect(g.tasks.map((t) => t.title)).toEqual(["b", "a"]);
  });

  it("omits empty groups", () => {
    expect(groupTasks([], TUE)).toEqual([]);
    expect(groupTasks([task("x", null)], TUE).map((g) => g.key)).toEqual(["someday"]);
  });
});

describe("times within a day", () => {
  it("puts all-day tasks first, then by time", () => {
    const groups = groupTasks(
      [
        task("late", "2026-10-14", { due_time: "17:00" }),
        task("all day", "2026-10-14"),
        task("early", "2026-10-14", { due_time: "08:30" }),
      ],
      TUE,
    );
    expect(groups[0].tasks.map((t) => t.title)).toEqual(["all day", "early", "late"]);
  });
});
