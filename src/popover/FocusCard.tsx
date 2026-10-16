import { useState } from "react";
import { SnoozeBar } from "../components/SnoozeBar";
import { addDays, relativeLabel, toISODate } from "../lib/dates";
import { timeLabel } from "../lib/schedule";
import type { TaskActions } from "../lib/taskActions";
import { sourceLabel } from "../lib/taskText";
import type { PopoverFocus, Task } from "../lib/types";

export type Focus = PopoverFocus;

/** Undated tasks listed before "and N more". */
const UNDATED_SHOWN = 5;

/**
 * A single card over the blurred popover: the task whose time just came, or
 * the daily "tasks without a date" check-in. One clear question, a few
 * one-tap answers, and a way out.
 */
export function FocusCard({
  focus,
  tasks,
  actions,
  locale,
  onFinish,
  onOpen,
}: {
  focus: Focus;
  tasks: Task[];
  actions: TaskActions;
  locale: string;
  /** Close the card (and the popover). */
  onFinish: (message?: string) => void;
  /** Open a task (or the list) in the main window. */
  onOpen: (task: Task | null) => void;
}) {
  return focus.kind === "due" ? (
    <DueFocus ids={focus.ids} tasks={tasks} actions={actions} locale={locale} onFinish={onFinish} onOpen={onOpen} />
  ) : (
    <UndatedFocus tasks={tasks} actions={actions} locale={locale} onFinish={onFinish} onOpen={onOpen} />
  );
}

function DueFocus({
  ids,
  tasks,
  actions,
  locale,
  onFinish,
  onOpen,
}: {
  ids: number[];
  tasks: Task[];
  actions: TaskActions;
  locale: string;
  onFinish: (message?: string) => void;
  onOpen: (task: Task | null) => void;
}) {
  const [handled, setHandled] = useState<number[]>([]);
  const queue = ids
    .filter((id) => !handled.includes(id))
    .map((id) => tasks.find((t) => t.id === id))
    .filter((t): t is Task => !!t && !t.done);
  const task = queue[0];
  if (!task) return null;
  const position = ids.length - queue.length + 1;

  function next(run: Promise<void>) {
    const rest = queue.length - 1;
    setHandled((h) => [...h, task.id]);
    void run.then(() => {
      if (rest === 0) onFinish();
    });
  }

  const when = task.due_time ? timeLabel(task.due_time, locale) : null;
  const from = sourceLabel(task);
  const detail = task.notes?.trim() || null;

  return (
    <div className="focus-card due" role="alertdialog" aria-labelledby="focus-title" aria-describedby="focus-kicker">
      <div className="focus-kicker" id="focus-kicker">
        <span className="focus-pulse" aria-hidden />
        <span>{task.snoozed_until ? "Reminder" : "Due now"}</span>
        {when && !task.snoozed_until && <span className="focus-when">· {when}</span>}
        {ids.length > 1 && (
          <span className="focus-count">
            {position} of {ids.length}
          </span>
        )}
      </div>
      <h2 className="focus-title" id="focus-title">
        {task.title}
      </h2>
      {(detail || from) && <p className="focus-meta">{detail ?? `From ${from}`}</p>}
      <SnoozeBar
        compact
        onDone={() => next(actions.setDone(task, true))}
        onSnooze={(kind) => next(actions.snooze(task, kind))}
      />
      <div className="focus-foot">
        <button type="button" className="focus-link" onClick={() => onOpen(task)}>
          Open in Plucky
        </button>
        <button type="button" className="focus-link quiet" onClick={() => next(Promise.resolve())}>
          {queue.length > 1 ? "Skip" : "Dismiss"}
        </button>
      </div>
    </div>
  );
}

function UndatedFocus({
  tasks,
  actions,
  locale,
  onFinish,
  onOpen,
}: {
  tasks: Task[];
  actions: TaskActions;
  locale: string;
  onFinish: (message?: string) => void;
  onOpen: (task: Task | null) => void;
}) {
  const [planned, setPlanned] = useState(0);
  const undated = tasks
    .filter((t) => !t.done && !t.due_date)
    .sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id - b.id);
  if (undated.length === 0 && planned === 0) return null;

  const now = new Date();
  const days = [
    { label: "Today", iso: toISODate(now) },
    { label: "Tomorrow", iso: toISODate(addDays(now, 1)) },
    { label: "Next week", iso: toISODate(addDays(now, 7)) },
  ];

  function plan(task: Task, iso: string) {
    const left = undated.length - 1;
    setPlanned((p) => p + 1);
    void actions.reschedule(task, { due_date: iso }).then(() => {
      if (left === 0) onFinish("All planned — nice.");
    });
  }

  const shown = undated.slice(0, UNDATED_SHOWN);
  const more = undated.length - shown.length;
  const n = undated.length;

  return (
    <div className="focus-card undated" role="dialog" aria-labelledby="focus-title">
      <div className="focus-kicker">
        <span className="focus-glyph" aria-hidden>
          ◷
        </span>
        <span>Daily check-in</span>
      </div>
      <h2 className="focus-title" id="focus-title">
        {n === 1 ? "1 task has no date" : `${n} tasks have no date`}
      </h2>
      <p className="focus-meta">Give {n === 1 ? "it" : "them"} a day so nothing slips. Plan now?</p>
      <ul className="focus-list">
        {shown.map((t) => (
          <li key={t.id}>
            <span className="focus-row-title" title={t.title}>
              {t.title}
            </span>
            <span className="focus-chips" role="group" aria-label={`Plan “${t.title}”`}>
              {days.map((d) => (
                <button
                  key={d.label}
                  type="button"
                  className="sn-chip"
                  title={relativeLabel(d.iso, now, locale)}
                  onClick={() => plan(t, d.iso)}
                >
                  {d.label}
                </button>
              ))}
            </span>
          </li>
        ))}
      </ul>
      {more > 0 && (
        <button type="button" className="focus-link" onClick={() => onOpen(null)}>
          and {more} more in Plucky
        </button>
      )}
      <div className="focus-foot">
        <button type="button" className="focus-link" onClick={() => onOpen(null)}>
          Open in Plucky
        </button>
        <button type="button" className="focus-link quiet" onClick={() => onFinish()}>
          Not now
        </button>
      </div>
    </div>
  );
}
