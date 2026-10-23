import { api } from "./api";
import { addDays, relativeLabel, toISODate } from "./dates";
import { formatLocal } from "./due";
import { timeLabel } from "./schedule";
import type { Task, TaskPatch } from "./types";
import type { Toast } from "../components/Toasts";

export type SnoozeKind = "15m" | "1h" | "tonight" | "tomorrow" | "week";

type Show = (text: string, action?: Toast["action"], tone?: Toast["tone"]) => number;

function short(title: string): string {
  return title.length > 34 ? `${title.slice(0, 33)}…` : title;
}

/**
 * Task changes that come with an Undo toast. Used by the panel and the
 * menu-bar popover so both behave the same.
 */
export function taskActions(show: Show, locale: string) {
  const fail = (e: unknown): void => {
    show(String(e), undefined, "error");
  };

  async function setDone(task: Task, done: boolean) {
    try {
      await api.updateTask(task.id, { done });
      if (!done) return;
      const next = task.recurrence ? " — next one is scheduled" : "";
      show(`Completed “${short(task.title)}”${next}`, {
        label: "Undo",
        run: () => api.updateTask(task.id, { done: false }).then(() => undefined, fail),
      });
    } catch (e) {
      fail(e);
    }
  }

  async function remove(task: Task) {
    try {
      await api.deleteTask(task.id);
      show(`Deleted “${short(task.title)}”`, {
        label: "Undo",
        run: () => api.restoreTask(task).then(() => undefined, fail),
      });
    } catch (e) {
      fail(e);
    }
  }

  /** Change a task's date, time or repeat. */
  async function reschedule(task: Task, patch: TaskPatch) {
    const before: TaskPatch = {
      due_date: task.due_date,
      due_time: task.due_time,
      recurrence: task.recurrence,
    };
    try {
      const t = await api.updateTask(task.id, patch);
      const dayMoved = patch.due_date !== undefined && patch.due_date !== task.due_date;
      const timeMoved = patch.due_time !== undefined && patch.due_time !== task.due_time;
      const parts: string[] = [];
      if (dayMoved && t.due_date) parts.push(relativeLabel(t.due_date, new Date(), locale).toLowerCase());
      if (timeMoved) parts.push(t.due_time ? timeLabel(t.due_time, locale) : "any time");
      const text = !t.due_date ? "Date removed" : parts.length ? `Moved to ${parts.join(", ")}` : "Updated";
      show(`${text} · “${short(task.title)}”`, {
        label: "Undo",
        run: () => api.updateTask(task.id, before).then(() => undefined, fail),
      });
    } catch (e) {
      fail(e);
    }
  }

  /** Move several tasks to one day (e.g. all overdue → today). */
  async function moveAll(tasks: Task[], day: string) {
    const before = tasks.map((t) => ({ id: t.id, due_date: t.due_date }));
    try {
      for (const t of tasks) await api.updateTask(t.id, { due_date: day });
      show(`Moved ${tasks.length} ${tasks.length === 1 ? "task" : "tasks"} to ${relativeLabel(day, new Date(), locale).toLowerCase()}`, {
        label: "Undo",
        run: async () => {
          try {
            for (const b of before) await api.updateTask(b.id, { due_date: b.due_date });
          } catch (e) {
            fail(e);
          }
        },
      });
    } catch (e) {
      fail(e);
    }
  }

  /** Remind later today, or move to tomorrow / next week. */
  async function snooze(task: Task, kind: SnoozeKind) {
    const now = new Date();
    const before: TaskPatch = { due_date: task.due_date, due_time: task.due_time, snoozed_until: task.snoozed_until };
    let patch: TaskPatch;
    let text: string;
    if (kind === "15m" || kind === "1h" || kind === "tonight") {
      const at =
        kind === "tonight"
          ? new Date(now.getFullYear(), now.getMonth(), now.getDate(), 20, 0)
          : new Date(now.getTime() + (kind === "15m" ? 15 : 60) * 60 * 1000);
      at.setSeconds(0, 0);
      patch = { snoozed_until: formatLocal(at) };
      text = `Snoozed until ${at.toLocaleTimeString(locale, { hour: "numeric", minute: "2-digit" })}`;
    } else {
      const day = toISODate(addDays(now, kind === "tomorrow" ? 1 : 7));
      patch = { due_date: day, snoozed_until: null };
      text = `Moved to ${relativeLabel(day, now, locale).toLowerCase()}`;
    }
    try {
      await api.updateTask(task.id, patch);
      show(`${text} · “${short(task.title)}”`, {
        label: "Undo",
        run: () => api.updateTask(task.id, before).then(() => undefined, fail),
      });
    } catch (e) {
      fail(e);
    }
  }

  async function update(task: Task, patch: TaskPatch) {
    try {
      await api.updateTask(task.id, patch);
    } catch (e) {
      fail(e);
    }
  }

  return { setDone, remove, reschedule, moveAll, snooze, update, fail };
}

export type TaskActions = ReturnType<typeof taskActions>;
