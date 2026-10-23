/**
 * How urgent a task is right now, as a small coloured chip:
 * overdue = red, soon (within 2 hours) or snoozed = amber, later today =
 * teal, another day = neutral, done = muted.
 */

import { daysBetween, parseISODate, startOfDay } from "./dates";
import { timeLabel } from "./schedule";
import type { Task } from "./types";

export type DueTone = "overdue" | "soon" | "today" | "later" | "done";

export interface DueChip {
  tone: DueTone;
  label: string;
}

const SOON_MS = 2 * 60 * 60 * 1000;

/** `YYYY-MM-DDTHH:MM:SS` local → Date. */
export function parseLocal(s: string): Date | null {
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/);
  if (!m) return null;
  return new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] ?? 0));
}

export function formatLocal(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function minutesText(ms: number): string {
  const mins = Math.max(1, Math.round(ms / 60000));
  if (mins < 60) return `${mins} min`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m ? `${h} h ${m} min` : `${h} h`;
}

/** The moment a task is due: its time, or the end of its day. */
export function dueAt(t: Pick<Task, "due_date" | "due_time">): Date | null {
  if (!t.due_date) return null;
  const d = parseISODate(t.due_date);
  if (t.due_time) {
    const [h, m] = t.due_time.split(":").map(Number);
    return new Date(d.getFullYear(), d.getMonth(), d.getDate(), h, m);
  }
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 23, 59, 59);
}

/** The chip for a task, or null when there's nothing worth saying. */
export function dueChip(t: Task, now: Date, locale?: string): DueChip | null {
  const time = t.due_time ? timeLabel(t.due_time, locale) : null;
  if (t.done) return time ? { tone: "done", label: time } : null;

  const snooze = t.snoozed_until ? parseLocal(t.snoozed_until) : null;
  if (snooze && snooze > now) {
    return { tone: "soon", label: `Snoozed · ${snooze.toLocaleTimeString(locale, { hour: "numeric", minute: "2-digit" })}` };
  }
  if (!t.due_date) return null;

  const days = daysBetween(startOfDay(now), parseISODate(t.due_date));
  if (days < 0) {
    const ago = -days === 1 ? "yesterday" : `${-days} days`;
    return { tone: "overdue", label: time ? `Overdue · ${ago}, ${time}` : `Overdue · ${ago}` };
  }
  if (days === 0) {
    if (!time) return null;
    const left = dueAt(t)!.getTime() - now.getTime();
    if (left < 0) return { tone: "overdue", label: `Overdue · ${time}` };
    if (left <= SOON_MS) return { tone: "soon", label: `${time} · in ${minutesText(left)}` };
    return { tone: "today", label: time };
  }
  return time ? { tone: "later", label: time } : null;
}

/**
 * Tasks whose reminder has gone off and still need an answer: shown in
 * the "Due now" card with Done / Snooze buttons.
 */
export function dueNow(tasks: Task[], now: Date): Task[] {
  const stale = 12 * 60 * 60 * 1000;
  return tasks.filter((t) => {
    if (t.done || t.paused || !t.notified_at) return false;
    const notified = parseLocal(t.notified_at);
    if (!notified || now.getTime() - notified.getTime() > stale) return false;
    const snooze = t.snoozed_until ? parseLocal(t.snoozed_until) : null;
    return !snooze || notified >= snooze;
  });
}
