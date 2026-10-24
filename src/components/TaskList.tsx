import { type ReactNode, useEffect, useRef, useState } from "react";
import { DateEditor } from "./DateEditor";
import { CalendarIcon, ClockIcon, RepeatIcon, TrashIcon } from "./icons";
import { SnoozeBar } from "./SnoozeBar";
import { Checklist, stepsLabel } from "./Checklist";
import { FlagIcon, FolderIcon, ProjectPicker, type ProjectInfo } from "./ProjectPicker";
import { deadlineChip } from "../lib/lists";
import { dueChip } from "../lib/due";
import { api } from "../lib/api";
import type { DayGroup } from "../lib/grouping";
import { repeatShort, timeLabel } from "../lib/schedule";
import { relativeLabel, toISODate } from "../lib/dates";
import type { TaskDrag } from "../lib/useTaskDrag";
import type { TaskActions } from "../lib/taskActions";
import { linkParts, sourceLabel, titleParts } from "../lib/taskText";
import type { ChecklistItem, Task, TaskPatch } from "../lib/types";

/** A keyboard command for one row (from the panel's shortcuts). */
export interface RowCommand {
  id: number;
  kind: "edit" | "date" | "snooze" | "notes" | "steps" | "project";
  /** Changes every time, so repeating the same command re-triggers it. */
  n: number;
}

interface Props {
  groups: DayGroup[];
  actions: TaskActions;
  now: Date;
  locale: string;
  /** Current capture shortcut, for the empty state. */
  shortcut: string;
  quickShortcut: string | null;
  /** Task to scroll to and flash (picked from the menu bar). */
  highlight: number | null;
  /** Keyboard focus (arrow keys). */
  focusId: number | null;
  onFocus: (id: number) => void;
  command: RowCommand | null;
  onTag: (tag: string) => void;
  /** A search or tag filter is active. */
  filtered: boolean;
  /** Today-only focus is on. */
  focusToday: boolean;
  today: string;
  /** Projects to move tasks into. */
  projects: ProjectInfo[];
  /** The project being viewed (its name isn't repeated on each row). */
  inProject: string | null;
  onOpenProject: (name: string) => void;
  /** Shown when there are no groups (instead of the general empty state). */
  emptyNote?: ReactNode;
  /** Selected for batch actions (⌘-click / Shift-click). */
  selected: Set<number>;
  onSelect: (id: number, mode: "toggle" | "range") => void;
  /** Drag rows onto a day (the week strip). */
  drag?: TaskDrag;
  /** The task opened as a card, if any. */
  openId: number | null;
  onOpenTask: (id: number | null) => void;
}

export function TaskList(props: Props) {
  const { groups, shortcut, quickShortcut, filtered, focusToday, actions, today, emptyNote } = props;
  if (!groups.length && emptyNote) return <div className="empty">{emptyNote}</div>;
  if (!groups.length && focusToday && !filtered) {
    return (
      <div className="empty">
        <EmptyArt />
        <p className="empty-big">Nothing left for today</p>
        <p>Open Upcoming in the list menu to see what’s next.</p>
      </div>
    );
  }
  if (!groups.length) {
    if (filtered) {
      return (
        <div className="empty">
          <p className="empty-big">No matching tasks</p>
          <p>Try fewer words, or clear the filter.</p>
        </div>
      );
    }
    return (
      <div className="empty">
        <EmptyArt />
        <p className="empty-big">All clear</p>
        <p>
          Select text in any app and press <kbd>{shortcut}</kbd>
          {quickShortcut && (
            <>
              , or press <kbd>{quickShortcut}</kbd> to type a task
            </>
          )}
          .
        </p>
      </div>
    );
  }
  return (
    <div className={props.openId !== null ? "groups has-open" : "groups"}>
      {groups.map((g) => (
        <section key={g.key} className={`group tone-${g.tone}`} aria-label={g.label}>
          <h2 className="day">
            {g.label}
            <span className="count">{g.tasks.length}</span>
            {g.tone === "overdue" && (
              <button
                type="button"
                className="day-action"
                onClick={() => void actions.moveAll(g.tasks, today)}
                title="Move every overdue task to today"
              >
                Move all to today
              </button>
            )}
          </h2>
          <ul>
            {g.tasks.map((t) => (
              <TaskRow key={t.id} task={t} {...props} />
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

function TaskRow({
  task,
  actions,
  now,
  locale,
  highlight,
  focusId,
  onFocus,
  command,
  onTag,
  projects,
  inProject,
  onOpenProject,
  selected,
  onSelect,
  drag,
  openId,
  onOpenTask,
}: { task: Task } & Props) {
  const ref = useRef<HTMLLIElement>(null);
  const highlighted = highlight === task.id;
  const focused = focusId === task.id;
  const open = openId === task.id;
  const [completing, setCompleting] = useState(false);
  // Which part of the open card is expanded: when (date, deadline, repeat), project or snooze.
  const [panel, setPanel] = useState<Panel>(null);
  const [focusPart, setFocusPart] = useState<"title" | "notes" | "steps" | null>(null);

  useEffect(() => {
    if (highlighted) ref.current?.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [highlighted]);
  useEffect(() => {
    if (focused) ref.current?.scrollIntoView({ block: "nearest" });
  }, [focused]);
  useEffect(() => {
    if (!open) {
      setPanel(null);
      setFocusPart(null);
    } else ref.current?.scrollIntoView({ block: "nearest" });
  }, [open]);
  useEffect(() => {
    if (!command || command.id !== task.id) return;
    // Every row command opens the task with the right part ready.
    onOpenTask(task.id);
    if (command.kind === "date") setPanel("when");
    if (command.kind === "project" && !task.done) setPanel("project");
    if (command.kind === "snooze" && !task.done) setPanel("snooze");
    if (command.kind === "edit") setFocusPart("title");
    if (command.kind === "notes") setFocusPart("notes");
    if (command.kind === "steps") setFocusPart("steps");
    // Only react to new commands.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [command]);

  // An open card closes on a click anywhere outside it (edits are already saved).
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      const t = e.target as HTMLElement;
      if (ref.current && !ref.current.contains(t) && !t.closest(".toasts, .batch, .keys-sheet")) onOpenTask(null);
    };
    document.addEventListener("pointerdown", onDown, true);
    return () => document.removeEventListener("pointerdown", onDown, true);
  }, [open, onOpenTask]);

  function toggle() {
    if (task.done) {
      void actions.setDone(task, false);
      return;
    }
    // Let the check animation play before the row leaves.
    setCompleting(true);
    if (open) onOpenTask(null);
    const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    window.setTimeout(() => void actions.setDone(task, true), reduce ? 0 : 420);
  }

  const check = (
    <button
      type="button"
      data-nodrag
      className={task.done || completing ? "check on" : "check"}
      onClick={toggle}
      aria-label={task.done ? `Mark “${task.title}” not done` : `Mark “${task.title}” done`}
      aria-pressed={task.done}
    >
      <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2.4">
        <path d="M3.5 8.5 6.5 11.5 12.5 4.5" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </button>
  );

  return (
    <li
      ref={ref}
      className={[
        "task",
        open ? "open" : "",
        task.done ? "done" : "",
        highlighted ? "flash" : "",
        focused && !open ? "focused" : "",
        completing ? "completing" : "",
        selected.has(task.id) ? "selected" : "",
        drag?.drag?.task.id === task.id ? "lifted" : "",
      ]
        .filter(Boolean)
        .join(" ")}
      aria-selected={selected.size ? selected.has(task.id) : undefined}
      onPointerDown={(e) => {
        if (!open && drag && !(e.metaKey || e.ctrlKey || e.shiftKey)) drag.start(e, task);
      }}
      onMouseDown={() => onFocus(task.id)}
      // ⌘-click toggles a task in the selection, Shift-click selects a range.
      onMouseDownCapture={(e) => {
        if (open || !(e.metaKey || e.ctrlKey || e.shiftKey) || e.button !== 0) return;
        e.preventDefault();
        e.stopPropagation();
        onFocus(task.id);
        onSelect(task.id, e.shiftKey ? "range" : "toggle");
      }}
      onClickCapture={(e) => {
        if (!open && (e.metaKey || e.ctrlKey || e.shiftKey)) {
          e.preventDefault();
          e.stopPropagation();
        }
      }}
    >
      {open ? (
        <TaskCard
          task={task}
          check={check}
          actions={actions}
          now={now}
          locale={locale}
          projects={projects}
          panel={panel}
          onPanel={setPanel}
          focusPart={focusPart}
          onClose={() => onOpenTask(null)}
        />
      ) : (
        <div
          className="task-row"
          title={task.done ? undefined : "Click to open · drag onto a day to move"}
          onClick={(e) => {
            if (drag?.wasDrag()) return;
            if ((e.target as HTMLElement).closest("button, a, input")) return;
            onOpenTask(task.id);
          }}
        >
          {check}
          <div className="task-main">
            <span className="task-title">
              {titleParts(task.title).map((p, i) =>
                p.tag ? (
                  <button
                    key={i}
                    type="button"
                    className="tag"
                    data-nodrag
                    onClick={() => onTag(p.text.toLowerCase())}
                  >
                    {p.text}
                  </button>
                ) : (
                  <span key={i}>{p.text}</span>
                ),
              )}
            </span>
            <RowMeta task={task} now={now} locale={locale} inProject={inProject} onOpenProject={onOpenProject} onError={actions.fail} />
          </div>
        </div>
      )}
    </li>
  );
}

type Panel = "when" | "project" | "snooze" | null;

/** One quiet grey line under a title; only lateness is red. */
function RowMeta({
  task,
  now,
  locale,
  inProject,
  onOpenProject,
  onError,
}: {
  task: Task;
  now: Date;
  locale: string;
  inProject: string | null;
  onOpenProject: (name: string) => void;
  onError: (e: unknown) => void;
}) {
  const parts: ReactNode[] = [];
  const when = whenText(task, now, locale);
  if (when) parts.push(<span key="w" className={when.late ? "late" : when.soon ? "soon" : undefined}>{when.text}</span>);
  const dl = deadlineChip(task, now, locale);
  if (dl) parts.push(<span key="dl" className={dl.tone === "overdue" ? "late" : undefined}>{dl.label}</span>);
  if (task.paused && !task.done) parts.push(<span key="p">Paused</span>);
  const steps = task.checklist ?? [];
  if (steps.length) parts.push(<span key="s">{stepsLabel(steps)} steps</span>);
  const link = firstLink(task.notes);
  if (link) {
    parts.push(
      <a
        key="l"
        href={link}
        data-nodrag
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          void api.openUrl(link).catch(onError);
        }}
      >
        {shortUrl(link)}
      </a>,
    );
  }
  if (task.project && task.project !== inProject) {
    parts.push(
      <button key="pr" type="button" className="meta-link" data-nodrag onClick={() => onOpenProject(task.project!)}>
        {task.project}
      </button>,
    );
  }
  const repeat = repeatShort(task.recurrence);
  if (repeat) parts.push(<span key="r">{repeat.toLowerCase()}</span>);
  const source = sourceLabel(task);
  if (source && !link) parts.push(<span key="src">from {source}</span>);
  if (!parts.length) return null;
  return (
    <div className="task-meta">
      {parts.map((p, i) => (
        <span key={i} className="meta-part">
          {i > 0 && <span className="meta-sep" aria-hidden> · </span>}
          {p}
        </span>
      ))}
    </div>
  );
}

/** "Tuesday" (late), "4:26 PM", "in 40 min", "Evening". */
function whenText(t: Task, now: Date, locale: string): { text: string; late?: boolean; soon?: boolean } | null {
  if (t.done) return null;
  const chip = dueChip(t, now, locale);
  const time = t.due_time ? timeLabel(t.due_time, locale) : null;
  if (chip?.tone === "overdue") {
    const today = toISODate(now);
    if (t.due_date && t.due_date < today) {
      const day = relativeLabel(t.due_date, now, locale);
      return { text: time ? `${day}, ${time}` : day, late: true };
    }
    return { text: time ?? "Late", late: true };
  }
  if (chip?.tone === "soon") return { text: chip.label, soon: true };
  if (time) return { text: t.evening ? `${time} · evening` : time };
  if (t.evening) return { text: "Evening" };
  return null;
}

function firstLink(notes: string | null): string | null {
  if (!notes) return null;
  return linkParts(notes).find((p) => p.url)?.url ?? null;
}

function shortUrl(url: string): string {
  const s = url.replace(/^(https?:\/\/(www\.)?|mailto:)/i, "").replace(/\/$/, "");
  return s.length > 28 ? `${s.slice(0, 27)}…` : s;
}

/**
 * A task opened in place: title, notes and steps to edit, and one row of
 * pills for when, deadline, project and repeat. Everything saves as you go.
 */
function TaskCard({
  task,
  check,
  actions,
  now,
  locale,
  projects,
  panel,
  onPanel,
  focusPart,
  onClose,
}: {
  task: Task;
  check: ReactNode;
  actions: TaskActions;
  now: Date;
  locale: string;
  projects: ProjectInfo[];
  panel: Panel;
  onPanel: (p: Panel) => void;
  focusPart: "title" | "notes" | "steps" | null;
  onClose: () => void;
}) {
  const [title, setTitle] = useState(task.title);
  const [notes, setNotes] = useState(task.notes ?? "");
  const [steps, setSteps] = useState<ChecklistItem[]>(task.checklist ?? []);
  const stepsKey = JSON.stringify(task.checklist ?? []);
  useEffect(() => setSteps(task.checklist ?? []), [stepsKey]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => setTitle(task.title), [task.title]);
  const notesRef = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (focusPart === "notes") notesRef.current?.focus();
  }, [focusPart]);
  // Grow the notes box with its text.
  useEffect(() => {
    const el = notesRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
  }, [notes]);

  function saveTitle() {
    const t = title.trim();
    if (t && t !== task.title) void actions.update(task, { title: t });
    else setTitle(task.title);
  }
  function saveNotes() {
    const n = notes.trim();
    if (n !== (task.notes ?? "")) void actions.update(task, { notes: n || null });
  }
  function saveSteps(next: ChecklistItem[]) {
    setSteps(next);
    void actions.update(task, { checklist: next });
  }
  function applyDate(patch: TaskPatch) {
    const keys = Object.keys(patch).filter((k) => k !== "only_this");
    if (keys.length === 1 && "due_date" in patch) void actions.reschedule(task, patch);
    else void actions.update(task, patch);
  }
  const toggle = (p: Panel) => onPanel(panel === p ? null : p);

  const chip = dueChip(task, now, locale);
  const whenLabel = task.someday
    ? "Someday"
    : task.due_date
      ? [relativeLabel(task.due_date, now, locale), task.due_time && timeLabel(task.due_time, locale), task.evening && "evening"]
          .filter(Boolean)
          .join(", ")
      : "When";
  const dl = deadlineChip(task, now, locale);
  const repeat = repeatShort(task.recurrence);
  const source = sourceLabel(task);

  return (
    <div
      className="task-card"
      role="group"
      aria-label={`Editing “${task.title}”`}
      // Keys typed here are for the card, not the list's shortcuts.
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Escape") {
          e.preventDefault();
          if (panel) onPanel(null);
          else onClose();
        }
      }}
    >
      <div className="tc-head">
        {check}
        <input
          className="tc-title"
          value={title}
          autoFocus={focusPart === "title" || focusPart === null}
          maxLength={200}
          aria-label="Title"
          onChange={(e) => setTitle(e.target.value)}
          onBlur={saveTitle}
          onKeyDown={(e) => {
            if (e.key === "Enter") (e.target as HTMLInputElement).blur();
          }}
        />
      </div>
      <textarea
        ref={notesRef}
        className="tc-notes"
        value={notes}
        rows={1}
        maxLength={2000}
        placeholder="Notes"
        aria-label="Notes"
        onChange={(e) => setNotes(e.target.value)}
        onBlur={saveNotes}
      />
      {task.notes && linkParts(task.notes).some((p) => p.url) && <Notes text={task.notes} onEdit={() => notesRef.current?.focus()} onError={actions.fail} />}
      <Checklist items={steps} onChange={saveSteps} autoFocusAdd={focusPart === "steps"} readOnly={task.done} />

      <div className="tc-pills">
        <button type="button" className={pillClass(panel === "when", !!task.due_date || task.someday, chip?.tone === "overdue")} onClick={() => toggle("when")}>
          <CalendarIcon /> {whenLabel}
        </button>
        <button type="button" className={pillClass(panel === "when", !!dl, dl?.tone === "overdue")} onClick={() => toggle("when")}>
          <FlagIcon /> {dl ? dl.label : "Deadline"}
        </button>
        <button type="button" className={pillClass(panel === "project", !!task.project, false)} onClick={() => toggle("project")}>
          <FolderIcon /> {task.project ? `${task.project}${task.heading ? ` · ${task.heading}` : ""}` : "Project"}
        </button>
        <button type="button" className={pillClass(panel === "when", !!repeat, false)} onClick={() => toggle("when")}>
          <RepeatIcon /> {repeat ? `${repeat}${task.paused ? " · paused" : ""}` : "Repeat"}
        </button>
      </div>

      {panel === "when" && (
        <DateEditor
          date={task.due_date}
          time={task.due_time}
          repeat={task.recurrence}
          evening={task.evening}
          someday={task.someday}
          deadline={task.deadline}
          paused={task.paused}
          onSkip={task.recurrence ? () => void actions.skip(task) : undefined}
          onPause={task.recurrence ? (p) => void actions.pause(task, p) : undefined}
          now={now}
          locale={locale}
          onApply={applyDate}
          onClose={() => onPanel(null)}
        />
      )}
      {panel === "project" && (
        <ProjectPicker
          projects={projects}
          project={task.project}
          heading={task.heading}
          onPick={(project, heading) => {
            void actions.update(task, { project, heading });
            onPanel(null);
          }}
        />
      )}
      {panel === "snooze" && !task.done && (
        <SnoozeBar
          onSnooze={(kind) => {
            onPanel(null);
            void actions.snooze(task, kind);
          }}
        />
      )}

      <div className="tc-foot">
        {source ? (
          <button
            type="button"
            className="tc-link"
            onClick={() => void api.openSource(task.id).catch(actions.fail)}
            title={task.source_url ?? `Open ${source}`}
          >
            From {source} ↗
          </button>
        ) : (
          <span className="tc-hint">Esc to close · saves as you go</span>
        )}
        <span className="tc-gap" />
        {!task.done && (
          <button type="button" className={panel === "snooze" ? "tc-link on" : "tc-link"} onClick={() => toggle("snooze")}>
            <ClockIcon /> Snooze
          </button>
        )}
        <button type="button" className="tc-link danger" onClick={() => void actions.remove(task)} aria-label={`Delete “${task.title}”`}>
          <TrashIcon /> Delete
        </button>
      </div>
    </div>
  );
}

function pillClass(on: boolean, set: boolean, late: boolean): string {
  return ["tc-pill", on ? "on" : "", set ? "set" : "", late ? "late" : ""].filter(Boolean).join(" ");
}

/** The description: one quiet line, links clickable, click to edit. */
function Notes({ text, onEdit, onError }: { text: string; onEdit: () => void; onError: (e: unknown) => void }) {
  return (
    <p className="task-notes" title={text} onClick={onEdit}>
      {linkParts(text).map((p, i) =>
        p.url ? (
          <a
            key={i}
            href={p.url}
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              void api.openUrl(p.url!).catch(onError);
            }}
          >
            {p.url.replace(/^(https?:\/\/(www\.)?|mailto:)/i, "")}
          </a>
        ) : (
          <span key={i}>{p.text}</span>
        ),
      )}
    </p>
  );
}

function EmptyArt() {
  return (
    <svg className="empty-art" width="56" height="56" viewBox="0 0 56 56" fill="none" aria-hidden>
      <circle cx="28" cy="28" r="26" stroke="currentColor" strokeOpacity="0.18" strokeWidth="2" />
      <path d="M18 29l7 7 13-15" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
