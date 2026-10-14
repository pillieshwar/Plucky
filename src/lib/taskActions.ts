import { api } from "./api";
import { relativeLabel } from "./dates";
import type { Task, TaskPatch } from "./types";
import type { Toast } from "../components/Toasts";

type Show = (text: string, action?: Toast["action"], tone?: Toast["tone"]) => number;

function short(title: string): string {
  return title.length > 34 ? `${title.slice(0, 33)}…` : title;
}

/**
 * Task changes that come with an Undo toast. Used by the panel and the
 * menu-bar popover so both behave the same.
 */
export function taskActions(show: Show, locale: string) {
  const fail = (e: unknown) => show(String(e), undefined, "error");

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
      const where = t.due_date ? `Moved to ${relativeLabel(t.due_date, new Date(), locale).toLowerCase()}` : "Date removed";
      const text = patch.due_date !== undefined && patch.due_date !== task.due_date ? where : "Updated";
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

  async function update(task: Task, patch: TaskPatch) {
    try {
      await api.updateTask(task.id, patch);
    } catch (e) {
      fail(e);
    }
  }

  return { setDone, remove, reschedule, moveAll, update, fail };
}

export type TaskActions = ReturnType<typeof taskActions>;
