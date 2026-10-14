import { daysBetween, parseISODate, relativeLabel } from "./dates";
import type { Task } from "./types";

export interface DayGroup {
  key: string;
  label: string;
  /** "overdue" | "today" | "upcoming" | "someday" | "done" — drives styling. */
  tone: "overdue" | "today" | "upcoming" | "someday" | "done";
  tasks: Task[];
}

/**
 * Group tasks for the right rail: Overdue, Today, then one group per future
 * day, then Someday (undated), then Done. Within a group, open tasks keep
 * creation order.
 */
export function groupTasks(tasks: Task[], reference: Date, locale?: string): DayGroup[] {
  const overdue: Task[] = [];
  const byDay = new Map<string, Task[]>();
  const someday: Task[] = [];
  const done: Task[] = [];

  for (const t of tasks) {
    if (t.done) {
      done.push(t);
    } else if (!t.due_date) {
      someday.push(t);
    } else if (daysBetween(reference, parseISODate(t.due_date)) < 0) {
      overdue.push(t);
    } else {
      const list = byDay.get(t.due_date) ?? [];
      list.push(t);
      byDay.set(t.due_date, list);
    }
  }

  const byCreated = (a: Task, b: Task) => a.created_at.localeCompare(b.created_at);
  const groups: DayGroup[] = [];

  if (overdue.length) {
    overdue.sort((a, b) => (a.due_date ?? "").localeCompare(b.due_date ?? "") || byCreated(a, b));
    groups.push({ key: "overdue", label: "Overdue", tone: "overdue", tasks: overdue });
  }

  for (const day of [...byDay.keys()].sort()) {
    const isToday = daysBetween(reference, parseISODate(day)) === 0;
    groups.push({
      key: day,
      label: relativeLabel(day, reference, locale),
      tone: isToday ? "today" : "upcoming",
      tasks: byDay.get(day)!.sort(byCreated),
    });
  }

  if (someday.length) groups.push({ key: "someday", label: "No date", tone: "someday", tasks: someday.sort(byCreated) });
  if (done.length) {
    done.sort((a, b) => (b.completed_at ?? "").localeCompare(a.completed_at ?? ""));
    groups.push({ key: "done", label: "Done", tone: "done", tasks: done });
  }
  return groups;
}
