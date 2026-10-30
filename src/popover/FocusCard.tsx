import { useState } from "react";
import { SourceChip } from "../components/SourceChip";
import { SnoozeBar } from "../components/SnoozeBar";
import { addDays, dayOrderForLocale, relativeLabel, toISODate } from "../lib/dates";
import { findSchedule, timeLabel } from "../lib/schedule";
import type { TaskActions } from "../lib/taskActions";
import { sourceLabel } from "../lib/taskText";
import { api } from "../lib/api";
import type { InboxItem, PopoverFocus, Task } from "../lib/types";

export type Focus = PopoverFocus;

/** Undated tasks listed before "and N more". */
const UNDATED_SHOWN = 5;

/**
 * A single card over the blurred popover: the task whose time just came, or
 * the daily "tasks without a date" check-in, or tasks AI agents sent. One clear question, a few
 * one-tap answers, and a way out.
 */
export function FocusCard({
  focus,
  tasks,
  inbox,
  actions,
  locale,
  onFinish,
  onOpen,
}: {
  focus: Focus;
  tasks: Task[];
  inbox: InboxItem[];
  actions: TaskActions;
  locale: string;
  /** Close the card (and the popover). */
  onFinish: (message?: string) => void;
  /** Open a task (or the list) in the main window. */
  onOpen: (task: Task | null) => void;
}) {
  if (focus.kind === "due")
    return <DueFocus ids={focus.ids} tasks={tasks} actions={actions} locale={locale} onFinish={onFinish} onOpen={onOpen} />;
  if (focus.kind === "inbox") return <InboxFocus items={inbox} actions={actions} locale={locale} onFinish={onFinish} />;
  return <UndatedFocus tasks={tasks} actions={actions} locale={locale} onFinish={onFinish} onOpen={onOpen} />;
}

/**
 * The item's date: as sent, or worked out from its deadline phrase ("by
 * Friday") relative to when it was noticed.
 */
export function itemSchedule(item: InboxItem, locale: string): { due_date: string | null; due_time: string | null } {
  if (item.due_date || !item.date_text) return { due_date: item.due_date, due_time: item.due_time };
  const received = new Date(item.received_at);
  const found = findSchedule(item.date_text, Number.isNaN(received.getTime()) ? new Date() : received, dayOrderForLocale(locale));
  return { due_date: found.date, due_time: found.date ? found.time : null };
}

/** "Fri, Oct 23 · 3:00 PM", or null without a date. */
function whenLabel(item: InboxItem, locale: string): string | null {
  const { due_date, due_time } = itemSchedule(item, locale);
  if (!due_date) return item.date_text ? `“${item.date_text}”` : null;
  const day = relativeLabel(due_date, new Date(), locale);
  return due_time ? `${day} · ${timeLabel(due_time, locale)}` : day;
}

/**
 * Tasks AI agents sent. Nothing joins the list until it's added here, so a
 * misled agent can't plant tasks (or links) on its own.
 */
function InboxFocus({
  items,
  actions,
  locale,
  onFinish,
}: {
  items: InboxItem[];
  actions: TaskActions;
  locale: string;
  onFinish: (message?: string) => void;
}) {
  const [busy, setBusy] = useState<number[]>([]);
  const [added, setAdded] = useState(0);
  const open = items.filter((i) => !busy.includes(i.id));
  if (items.length === 0) return null;

  const agents = [...new Set(items.map((i) => i.agent))];
  const n = items.length;
  const noticed = items.every((i) => i.source === "watch");
  const sent = items.every((i) => i.source !== "watch");
  const heading = noticed
    ? agents.length === 1
      ? `${n === 1 ? "A to-do" : `${n} to-dos`} in ${agents[0]}`
      : `${n} to-dos noticed on screen`
    : sent && agents.length === 1
      ? `${agents[0]} sent ${n === 1 ? "a task" : `${n} tasks`}`
      : `${n} tasks to review`;

  async function review(list: InboxItem[], accept: boolean) {
    setBusy((b) => [...b, ...list.map((i) => i.id)]);
    let count = 0;
    for (const item of list) {
      try {
        if (accept) {
          await api.inboxAccept(item.id, itemSchedule(item, locale));
          count++;
        } else {
          await api.inboxDiscard(item.id);
        }
      } catch (e) {
        actions.fail(e);
      }
    }
    const total = added + count;
    setAdded(total);
    if (list.length === open.length) {
      onFinish(total > 0 ? `Added ${total} ${total === 1 ? "task" : "tasks"}` : undefined);
    }
  }

  return (
    <div className="focus-card inbox" role="dialog" aria-labelledby="focus-title">
      <div className="focus-kicker">
        <span className="focus-glyph" aria-hidden>
          ✦
        </span>
        <span>{noticed ? "Noticed on screen" : sent ? "From AI agents" : "Suggested tasks"}</span>
      </div>
      <h2 className="focus-title" id="focus-title">
        {heading}
      </h2>
      <p className="focus-meta">
        {noticed
          ? "TodoCity spotted these in new messages, on this Mac. Add the ones you want."
          : "Add the ones you want. Agents can add tasks, but never see your list."}
      </p>
      <ul className="focus-list">
        {open.map((item) => {
          const when = whenLabel(item, locale);
          return (
            <li key={item.id}>
              <span className="focus-row-title" title={item.title}>
                {item.title}
              </span>
              <span className="focus-row-meta">
                {[when ?? "No date", agents.length > 1 ? `from ${item.agent}` : null].filter(Boolean).join(" · ")}
              </span>
              {item.notes && <span className="focus-row-notes">{item.notes}</span>}
              <span className="focus-chips">
                <button type="button" className="sn-chip done" onClick={() => void review([item], true)}>
                  Add
                </button>
                <button type="button" className="sn-chip" onClick={() => void review([item], false)}>
                  Discard
                </button>
              </span>
            </li>
          );
        })}
      </ul>
      <div className="focus-foot">
        {open.length > 1 ? (
          <button type="button" className="focus-link" onClick={() => void review(open, true)}>
            Add all {open.length}
          </button>
        ) : (
          <span />
        )}
        <button type="button" className="focus-link quiet" onClick={() => onFinish()}>
          Later
        </button>
      </div>
    </div>
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
      {(detail || from) && <p className="focus-meta">{detail ?? <SourceChip task={task} />}</p>}
      <SnoozeBar
        compact
        onDone={() => next(actions.setDone(task, true))}
        onSnooze={(kind) => next(actions.snooze(task, kind))}
      />
      <div className="focus-foot">
        <button type="button" className="focus-link" onClick={() => onOpen(task)}>
          Open in TodoCity
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
          and {more} more in TodoCity
        </button>
      )}
      <div className="focus-foot">
        <button type="button" className="focus-link" onClick={() => onOpen(null)}>
          Open in TodoCity
        </button>
        <button type="button" className="focus-link quiet" onClick={() => onFinish()}>
          Not now
        </button>
      </div>
    </div>
  );
}
