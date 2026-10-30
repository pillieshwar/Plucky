import { addDays, parseISODate, toISODate } from "./dates";
import type { CalendarEvent, Task, TaskPatch } from "./types";
import { clockHour12 } from "./schedule";

/**
 * The day plan: a day's open tasks laid out by hour, so a task can sit in a
 * time block ("12 – 1 PM") and be dragged between blocks and days.
 *
 * A block is an hour; a task's block is the hour of its `due_time`. Tasks
 * without a time are "Anytime". Done tasks leave the plan.
 */
export interface DayPlan {
  /** Open tasks for the day with no time — plus, on today, overdue ones. */
  anytime: Task[];
  /** Open timed tasks by hour (0–23), earliest first. */
  byHour: Map<number, Task[]>;
}

export const hourOf = (time: string): number => Number(time.slice(0, 2));

const byTime = (a: Task, b: Task) =>
  (a.due_time ?? "").localeCompare(b.due_time ?? "") || a.created_at.localeCompare(b.created_at);

export function planFor(tasks: Task[], day: string, today: string): DayPlan {
  const anytime: Task[] = [];
  const byHour = new Map<number, Task[]>();
  const overdue: Task[] = [];
  for (const t of tasks) {
    if (t.done || !t.due_date || t.paused) continue;
    if (t.due_date === day) {
      if (t.due_time) {
        const h = hourOf(t.due_time);
        byHour.set(h, [...(byHour.get(h) ?? []), t]);
      } else anytime.push(t);
    } else if (day === today && t.due_date < today) {
      overdue.push(t);
    }
  }
  for (const list of byHour.values()) list.sort(byTime);
  anytime.sort((a, b) => a.created_at.localeCompare(b.created_at));
  overdue.sort((a, b) => (a.due_date ?? "").localeCompare(b.due_date ?? "") || byTime(a, b));
  return { anytime: [...overdue, ...anytime], byHour };
}

/** Calendar events for one day: all-day ones, and timed ones by start hour. */
export interface DayEvents {
  allDay: CalendarEvent[];
  byHour: Map<number, CalendarEvent[]>;
}

export function eventsForDay(events: CalendarEvent[], day: string): DayEvents {
  const allDay: CalendarEvent[] = [];
  const byHour = new Map<number, CalendarEvent[]>();
  const dayStart = `${day}T00:00`;
  const dayEnd = `${toISODate(addDays(parseISODate(day), 1))}T00:00`;
  for (const e of events) {
    const s = e.start.slice(0, 16);
    const en = e.end.slice(0, 16);
    if (e.all_day) {
      // All-day events end at midnight of the day after.
      if (s.slice(0, 10) <= day && en.slice(0, 10) > day) allDay.push(e);
      continue;
    }
    if (!(s < dayEnd && en > dayStart)) continue;
    if (s <= dayStart && en >= dayEnd) {
      allDay.push(e);
      continue;
    }
    // Started on an earlier day: it shows at midnight ("until …").
    const h = s < dayStart ? 0 : hourOf(s.slice(11, 16));
    byHour.set(h, [...(byHour.get(h) ?? []), e]);
  }
  return { allDay, byHour };
}

/**
 * The hours to draw: 7 AM – 9 PM by default, widened to take in any task or
 * event outside that range.
 */
export function hourRange(plan: DayPlan, events: DayEvents, from = 7, to = 21): number[] {
  let lo = from;
  let hi = to;
  for (const h of [...plan.byHour.keys(), ...events.byHour.keys()]) {
    lo = Math.min(lo, h);
    hi = Math.max(hi, h);
  }
  return Array.from({ length: hi - lo + 1 }, (_, i) => lo + i);
}

/**
 * Where a dragged task was dropped: a day (`iso`; `hour`: a block, `null` =
 * Anytime, absent = keep its time), or a place — a building, or one of its
 * floors (`heading`; null = the ground floor, absent = a building's row).
 */
export interface DropTarget {
  iso?: string;
  /** No date: Inbox's Someday column. */
  nodate?: boolean;
  hour?: number | null;
  /** With `hour`: the minute in that hour, snapped to 5. */
  minute?: number;
  place?: { project: string; heading?: string | null };
}

/** The change dropping on a building or floor makes, or null if none. */
export function placePatch(task: Task, place: NonNullable<DropTarget["place"]>): TaskPatch | null {
  const sameProject = task.project === place.project;
  // A building's row: into the building (its ground floor), or stay put if already in it.
  const heading = place.heading === undefined ? (sameProject ? task.heading : null) : place.heading;
  if (sameProject && (task.heading ?? null) === (heading ?? null)) return null;
  return { project: place.project, heading: heading ?? null };
}

/** The change a drop makes, or null if it changes nothing. */
export function dropPatch(task: Task, to: DropTarget): TaskPatch | null {
  if (to.place) return placePatch(task, to.place);
  if (to.nodate) return task.due_date || !task.someday ? { due_date: null, due_time: null, someday: true } : null;
  if (!to.iso) return null;
  const patch: TaskPatch = {};
  // A parked task given a day comes back from Someday.
  if (task.someday) patch.someday = false;
  if (to.iso !== task.due_date) patch.due_date = to.iso;
  if (to.hour === null) {
    if (task.due_time) patch.due_time = null;
  } else if (to.hour !== undefined) {
    if (to.minute !== undefined) {
      // Dropped at a point in the hour: start there (snapped to 5 minutes).
      const at = `${String(to.hour).padStart(2, "0")}:${String(to.minute).padStart(2, "0")}`;
      if (at !== task.due_time) patch.due_time = at;
    } else {
      const sameBlock = task.due_time && hourOf(task.due_time) === to.hour;
      // Keep the minutes when it stays in its block (only the day moved).
      if (!sameBlock) patch.due_time = `${String(to.hour).padStart(2, "0")}:00`;
    }
  }
  if (!Object.keys(patch).length) return null;
  // Dragging one day of a repeating task moves just that one.
  if (task.recurrence && patch.due_date !== undefined) patch.only_this = true;
  return patch;
}

/** "9 AM", "12 PM", "21" (24-hour locales). */
export function hourLabel(hour: number, locale?: string): string {
  const d = new Date(2000, 0, 1, hour, 0);
  try {
    return d.toLocaleTimeString(locale, { hour: "numeric", hour12: clockHour12() });
  } catch {
    return `${hour}:00`;
  }
}
