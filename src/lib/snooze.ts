import { addDays, relativeLabel, toISODate } from "./dates";
import { formatLocal } from "./due";
import { timeLabel } from "./schedule";
import type { Task, TaskPatch } from "./types";

export type SnoozeKind = "15m" | "1h" | "tonight" | "tomorrow" | "week";

/**
 * What a snooze changes, and the toast text for it.
 *
 * "15 min", "1 hour" and "Tonight" move the task itself to that time, so the
 * list, the calendar and the hour blocks all show the new time. A repeating
 * task keeps its time (moving it would shift every later one too) and is
 * only reminded again later. "Tomorrow" and "Next week" move the day.
 */
export function snoozePlan(task: Task, kind: SnoozeKind, now: Date, locale?: string): { patch: TaskPatch; text: string } {
  if (kind === "tomorrow" || kind === "week") {
    const day = toISODate(addDays(now, kind === "tomorrow" ? 1 : 7));
    return { patch: { due_date: day, snoozed_until: null }, text: `Moved to ${relativeLabel(day, now, locale).toLowerCase()}` };
  }
  const at =
    kind === "tonight"
      ? new Date(now.getFullYear(), now.getMonth(), now.getDate(), 20, 0)
      : new Date(now.getTime() + (kind === "15m" ? 15 : 60) * 60 * 1000);
  at.setSeconds(0, 0);
  const time = `${String(at.getHours()).padStart(2, "0")}:${String(at.getMinutes()).padStart(2, "0")}`;
  if (task.recurrence) {
    return { patch: { snoozed_until: formatLocal(at) }, text: `Snoozed until ${timeLabel(time, locale)}` };
  }
  const day = toISODate(at);
  const moved = day === toISODate(now) ? timeLabel(time, locale) : `${relativeLabel(day, now, locale).toLowerCase()}, ${timeLabel(time, locale)}`;
  return { patch: { due_date: day, due_time: time }, text: `Moved to ${moved}` };
}
