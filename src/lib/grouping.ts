import { daysBetween, parseISODate, relativeLabel, toISODate } from "./dates";
import { effectiveDay } from "./lists";
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
  const parked: Task[] = [];
  const done: Task[] = [];
  const todayIso = toISODate(reference);

  for (const t of tasks) {
    // A deadline that has come pulls a later-planned task forward.
    const day = t.done ? null : effectiveDay(t, todayIso);
    if (t.done) {
      done.push(t);
    } else if (!day) {
      (t.someday ? parked : someday).push(t);
    } else if (daysBetween(reference, parseISODate(day)) < 0) {
      overdue.push(t);
    } else {
      const list = byDay.get(day) ?? [];
      list.push(t);
      byDay.set(day, list);
    }
  }

  const byCreated = (a: Task, b: Task) => a.created_at.localeCompare(b.created_at);
  // All-day tasks first, then by time of day; evening ones last.
  const byTime = (a: Task, b: Task) =>
    Number(!!a.evening) - Number(!!b.evening) ||
    Number(a.due_time !== null) - Number(b.due_time !== null) ||
    (a.due_time ?? "").localeCompare(b.due_time ?? "") ||
    byCreated(a, b);
  const groups: DayGroup[] = [];

  if (overdue.length) {
    overdue.sort((a, b) => (a.due_date ?? "").localeCompare(b.due_date ?? "") || byTime(a, b));
    groups.push({ key: "overdue", label: "Overdue", tone: "overdue", tasks: overdue });
  }

  for (const day of [...byDay.keys()].sort()) {
    const isToday = daysBetween(reference, parseISODate(day)) === 0;
    const list = byDay.get(day)!.sort(byTime);
    // Today splits into now and This Evening.
    const evening = isToday ? list.filter((t) => t.evening) : [];
    const rest = isToday ? list.filter((t) => !t.evening) : list;
    if (rest.length) {
      groups.push({
        key: day,
        label: relativeLabel(day, reference, locale),
        tone: isToday ? "today" : "upcoming",
        tasks: rest,
      });
    }
    if (evening.length) groups.push({ key: `${day}:evening`, label: "This Evening", tone: "today", tasks: evening });
  }

  if (someday.length) groups.push({ key: "someday", label: "No date", tone: "someday", tasks: someday.sort(byCreated) });
  if (parked.length) groups.push({ key: "parked", label: "Someday", tone: "someday", tasks: parked.sort(byCreated) });
  if (done.length) {
    done.sort((a, b) => (b.completed_at ?? "").localeCompare(a.completed_at ?? ""));
    groups.push({ key: "done", label: "Done", tone: "done", tasks: done });
  }
  return groups;
}
