import { daysBetween, parseISODate, relativeLabel } from "./dates";
import type { DayGroup } from "./grouping";
import type { Task } from "./types";

/**
 * Which tasks the panel's list shows: everything, today only, Someday, the
 * Logbook, or one project.
 */
export type ListId = "all" | "today" | "someday" | "logbook" | `project:${string}`;

export const projectList = (name: string): ListId => `project:${name}`;
export const projectOf = (id: ListId): string | null => (id.startsWith("project:") ? id.slice(8) : null);

/**
 * The day a task counts as due for the list: its planned day — or, when a
 * deadline has come (or passed) before that, the deadline. So a task planned
 * for next week but due today shows up today.
 */
export function effectiveDay(t: Task, today: string): string | null {
  if (t.deadline && t.deadline <= today && (!t.due_date || t.due_date > t.deadline)) return t.deadline;
  return t.due_date;
}

/** Tasks for a list (Logbook is loaded separately). */
export function tasksForList(tasks: Task[], list: ListId, today: string): Task[] {
  const project = projectOf(list);
  if (project !== null) return tasks.filter((t) => t.project === project);
  if (list === "someday") return tasks.filter((t) => !t.done && t.someday);
  // Someday tasks stay out of the way everywhere else.
  const active = tasks.filter((t) => !t.someday || t.done);
  if (list === "today") {
    return active.filter((t) => {
      const d = effectiveDay(t, today);
      return d !== null && d <= today;
    });
  }
  return active;
}

/** "Due Fri" chip for a deadline, toned by how close it is. */
export function deadlineChip(t: Task, now: Date, locale?: string): { label: string; tone: "overdue" | "soon" | "later" } | null {
  if (!t.deadline || t.done) return null;
  const days = daysBetween(now, parseISODate(t.deadline));
  const label = days < 0 ? `Was due ${relativeLabel(t.deadline, now, locale)}` : days === 0 ? "Due today" : `Due ${relativeLabel(t.deadline, now, locale)}`;
  return { label, tone: days <= 0 ? "overdue" : days <= 2 ? "soon" : "later" };
}

/**
 * A project's tasks by heading: tasks without a heading first, then each
 * heading in the order it was first used; completed ones at the end.
 */
export function groupByHeading(tasks: Task[]): DayGroup[] {
  const open = tasks.filter((t) => !t.done).sort((a, b) => a.created_at.localeCompare(b.created_at));
  const done = tasks.filter((t) => t.done).sort((a, b) => (b.completed_at ?? "").localeCompare(a.completed_at ?? ""));
  const sections = new Map<string, Task[]>();
  for (const t of open) {
    const k = t.heading ?? "";
    sections.set(k, [...(sections.get(k) ?? []), t]);
  }
  const groups: DayGroup[] = [];
  const loose = sections.get("");
  if (loose) groups.push({ key: "h:", label: "Tasks", tone: "upcoming", tasks: loose });
  for (const [k, list] of sections) {
    if (k) groups.push({ key: `h:${k}`, label: k, tone: "upcoming", tasks: list });
  }
  if (done.length) groups.push({ key: "done", label: "Done", tone: "done", tasks: done });
  return groups;
}

/** Headings used in a project, in first-use order. */
export function headingsOf(tasks: Task[], project: string): string[] {
  const seen: string[] = [];
  for (const t of [...tasks].sort((a, b) => a.created_at.localeCompare(b.created_at))) {
    if (t.project === project && t.heading && !seen.includes(t.heading)) seen.push(t.heading);
  }
  return seen;
}

/** Steps typed or pasted as lines ("- milk", "• eggs", "1. bread") → checklist texts. */
export function linesToSteps(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((l) => l.replace(/^\s*(?:[-*•◦▪‣–—]|\[[ xX]?\]|\d{1,2}[.)])\s*/, "").trim())
    .filter(Boolean)
    .slice(0, 50);
}

/**
 * Bulleted or numbered lines in a selection (two or more), offered as a
 * checklist when it becomes a task.
 */
export function bulletSteps(text: string | null): string[] {
  if (!text) return [];
  const bullets = text
    .split(/\r?\n/)
    .filter((l) => /^\s*(?:[-*•◦▪‣]|\[[ xX]?\]|\d{1,2}[.)])\s+\S/.test(l));
  return bullets.length >= 2 ? linesToSteps(bullets.join("\n")) : [];
}

/** "by Friday", "before 5pm", "due Monday", "no later than…" — a deadline, not just a day. */
export function isDeadlinePhrase(text: string | null | undefined): boolean {
  return !!text && /^\s*(by|before|due|no later than|until|deadline)\b/i.test(text);
}
