import { type ReactNode, useEffect, useRef, useState } from "react";
import { DateEditor } from "./DateEditor";
import { CalendarIcon, ClockIcon, NoteIcon, RepeatIcon, TrashIcon } from "./icons";
import { SnoozeBar } from "./SnoozeBar";
import { Checklist, stepsLabel } from "./Checklist";
import { FlagIcon, FolderIcon, MoonIcon, ProjectPicker, StepsIcon, type ProjectInfo } from "./ProjectPicker";
import { deadlineChip } from "../lib/lists";
import { dueChip } from "../lib/due";
import { api } from "../lib/api";
import type { DayGroup } from "../lib/grouping";
import { repeatLabel, repeatShort } from "../lib/schedule";
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
}

export function TaskList(props: Props) {
  const { groups, shortcut, quickShortcut, filtered, focusToday, actions, today, emptyNote } = props;
  if (!groups.length && emptyNote) return <div className="empty">{emptyNote}</div>;
  if (!groups.length && focusToday && !filtered) {
    return (
      <div className="empty">
        <EmptyArt />
        <p className="empty-big">Nothing left for today</p>
        <p>Turn off Today focus to see what’s coming up.</p>
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
    <div className="groups">
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
}: { task: Task } & Props) {
  const ref = useRef<HTMLLIElement>(null);
  const highlighted = highlight === task.id;
  const focused = focusId === task.id;
  const [editing, setEditing] = useState(false);
  const [picking, setPicking] = useState(false);
  const [snoozing, setSnoozing] = useState(false);
  const [notesOpen, setNotesOpen] = useState(false);
  const [completing, setCompleting] = useState(false);
  const [draft, setDraft] = useState(task.title);
  const [moving, setMoving] = useState(false);
  // Steps: shown when opened; edited optimistically so quick ticks don't race.
  const [stepsOpen, setStepsOpen] = useState(false);
  const [steps, setSteps] = useState<ChecklistItem[]>(task.checklist ?? []);
  const stepsKey = JSON.stringify(task.checklist ?? []);
  useEffect(() => setSteps(task.checklist ?? []), [stepsKey]); // eslint-disable-line react-hooks/exhaustive-deps
  function saveSteps(next: ChecklistItem[]) {
    setSteps(next);
    void actions.update(task, { checklist: next });
  }

  useEffect(() => {
    if (highlighted) ref.current?.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [highlighted]);
  useEffect(() => {
    if (focused) ref.current?.scrollIntoView({ block: "nearest" });
  }, [focused]);
  useEffect(() => {
    if (!command || command.id !== task.id) return;
    if (command.kind === "edit" && !task.done) {
      setDraft(task.title);
      setEditing(true);
    }
    if (command.kind === "date") setPicking((p) => !p);
    if (command.kind === "snooze" && !task.done) setSnoozing((v) => !v);
    if (command.kind === "notes") setNotesOpen(true);
    if (command.kind === "steps") setStepsOpen((v) => !v);
    if (command.kind === "project" && !task.done) setMoving((v) => !v);
    // Only react to new commands.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [command]);

  // While the date or snooze editor is open: a click anywhere outside this
  // row closes it (nothing is lost — every choice applies as it's made).
  useEffect(() => {
    if (!picking && !snoozing && !moving) return;
    const onDown = (e: PointerEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setPicking(false);
        setSnoozing(false);
        setMoving(false);
      }
    };
    document.addEventListener("pointerdown", onDown, true);
    return () => document.removeEventListener("pointerdown", onDown, true);
  }, [picking, snoozing, moving]);
  const closeEditors = () => {
    setPicking(false);
    setSnoozing(false);
    setMoving(false);
  };

  function commit() {
    setEditing(false);
    const title = draft.trim();
    if (title && title !== task.title) void actions.update(task, { title });
    else setDraft(task.title);
  }

  function toggle() {
    if (task.done) {
      void actions.setDone(task, false);
      return;
    }
    // Let the check animation play before the row moves to "Done".
    setCompleting(true);
    const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    window.setTimeout(() => void actions.setDone(task, true), reduce ? 0 : 420);
  }

  function applyDate(patch: TaskPatch) {
    const keys = Object.keys(patch).filter((k) => k !== "only_this");
    const dayOnly = keys.length === 1 && "due_date" in patch;
    if (dayOnly) void actions.reschedule(task, patch);
    else void actions.update(task, patch);
  }

  const source = sourceLabel(task);
  const repeat = repeatLabel(task.recurrence);
  const meta: ReactNode[] = [];
  const chip = dueChip(task, now, locale);
  if (chip) {
    meta.push(
      <span key="due" className={`due-chip ${chip.tone}`}>
        {chip.tone !== "overdue" && <ClockIcon />}
        {chip.label}
      </span>,
    );
  }
  const dl = deadlineChip(task, now, locale);
  if (dl) {
    meta.push(
      <span key="dl" className={`due-chip deadline ${dl.tone}`} title={`Deadline: ${task.deadline}`}>
        <FlagIcon />
        {dl.label}
      </span>,
    );
  }
  if (task.paused && !task.done) {
    meta.push(
      <span key="paused" className="meta-paused" title="Paused: no reminders until you resume it (date menu)">
        ❚❚ Paused
      </span>,
    );
  }
  if (task.evening && !task.done) {
    meta.push(
      <span key="eve" className="meta-evening" title="Planned for the evening">
        <MoonIcon /> Evening
      </span>,
    );
  }
  if (steps.length > 0) {
    meta.push(
      <button
        key="steps"
        type="button"
        className={stepsOpen ? "meta-steps on" : "meta-steps"}
        onClick={() => setStepsOpen((v) => !v)}
        aria-expanded={stepsOpen}
        title={stepsOpen ? "Hide steps (C)" : "Show steps (C)"}
      >
        <StepsIcon /> {stepsLabel(steps)}
      </button>,
    );
  }
  if (task.project && task.project !== inProject) {
    meta.push(
      <button key="proj" type="button" className="meta-project" onClick={() => onOpenProject(task.project!)} title={`Open ${task.project}`}>
        <FolderIcon /> {task.project}
        {task.heading ? ` · ${task.heading}` : ""}
      </button>,
    );
  }
  if (repeat) {
    meta.push(
      <span key="r" className="meta-repeat" title={repeat}>
        <RepeatIcon /> {repeatShort(task.recurrence)}
      </span>,
    );
  }
  if (source) {
    meta.push(
      <button
        key="src"
        type="button"
        className="meta-source"
        onClick={() => void api.openSource(task.id).catch(actions.fail)}
        title={task.source_url ?? `Open ${source}`}
      >
        {source} <span aria-hidden>↗</span>
      </button>,
    );
  }

  return (
    <li
      ref={ref}
      className={[
        "task",
        task.done ? "done" : "",
        picking || snoozing || moving ? "picking" : "",
        highlighted ? "flash" : "",
        focused ? "focused" : "",
        completing ? "completing" : "",
        selected.has(task.id) ? "selected" : "",
      ]
        .filter(Boolean)
        .join(" ")}
      aria-selected={selected.size ? selected.has(task.id) : undefined}
      onMouseDown={() => onFocus(task.id)}
      // ⌘-click toggles a task in the selection, Shift-click selects a range.
      onMouseDownCapture={(e) => {
        if (!(e.metaKey || e.ctrlKey || e.shiftKey) || e.button !== 0) return;
        e.preventDefault();
        e.stopPropagation();
        onFocus(task.id);
        onSelect(task.id, e.shiftKey ? "range" : "toggle");
      }}
      onClickCapture={(e) => {
        if (e.metaKey || e.ctrlKey || e.shiftKey) {
          e.preventDefault();
          e.stopPropagation();
        }
      }}
    >
      <div className="task-row" title={task.source_text ?? undefined}>
        <button
          type="button"
          className={task.done || completing ? "check on" : "check"}
          onClick={toggle}
          aria-label={task.done ? `Mark “${task.title}” not done` : `Mark “${task.title}” done`}
          aria-pressed={task.done}
        >
          <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2.4">
            <path d="M3.5 8.5 6.5 11.5 12.5 4.5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
        <div className="task-main">
          {editing ? (
            <input
              className="task-edit"
              autoFocus
              value={draft}
              maxLength={200}
              onChange={(e) => setDraft(e.target.value)}
              onBlur={commit}
              onKeyDown={(e) => {
                if (e.key === "Enter") commit();
                if (e.key === "Escape") {
                  e.stopPropagation();
                  setDraft(task.title);
                  setEditing(false);
                }
              }}
              aria-label="Task title"
            />
          ) : (
            <span
              className="task-title"
              onDoubleClick={() => {
                if (task.done) return;
                setDraft(task.title);
                setEditing(true);
              }}
            >
              {titleParts(task.title).map((p, i) =>
                p.tag ? (
                  <button key={i} type="button" className="tag" onClick={() => onTag(p.text.toLowerCase())}>
                    {p.text}
                  </button>
                ) : (
                  <span key={i}>{p.text}</span>
                ),
              )}
            </span>
          )}
          {notesOpen ? (
            <NotesEditor
              initial={task.notes ?? ""}
              onDone={(notes) => {
                setNotesOpen(false);
                if (notes !== null && notes.trim() !== (task.notes ?? "")) void actions.update(task, { notes: notes.trim() || null });
              }}
            />
          ) : (
            task.notes && <Notes text={task.notes} onEdit={() => setNotesOpen(true)} onError={actions.fail} />
          )}
          {meta.length > 0 && <div className="task-meta">{meta}</div>}
          {stepsOpen && (
            <Checklist items={steps} onChange={saveSteps} autoFocusAdd={steps.length === 0} readOnly={task.done} />
          )}
        </div>
        {picking || snoozing || moving ? (
          <div className="task-tools open">
            <button
              type="button"
              className="task-done-editing"
              onClick={closeEditors}
              aria-label={picking ? "Close the date editor" : moving ? "Close project options" : "Close snooze options"}
            >
              Close
            </button>
          </div>
        ) : (
          <div className="task-tools">
            {!task.done && (
              <button
                type="button"
                className="task-date"
                title="Snooze (S)"
                aria-label="Snooze"
                onClick={() => setSnoozing(true)}
              >
                <ClockIcon />
              </button>
            )}
            {steps.length === 0 && !stepsOpen && !task.done && (
              <button
                type="button"
                className="task-date"
                title="Add steps (C)"
                aria-label="Add a checklist"
                onClick={() => setStepsOpen(true)}
              >
                <StepsIcon />
              </button>
            )}
            {!task.done && (
              <button
                type="button"
                className="task-date"
                title="Move to a project (P)"
                aria-label="Move to a project"
                onClick={() => setMoving(true)}
              >
                <FolderIcon />
              </button>
            )}
            {!task.notes && !notesOpen && (
              <button
                type="button"
                className="task-date"
                title="Add a description (N)"
                aria-label="Add a description"
                onClick={() => setNotesOpen(true)}
              >
                <NoteIcon />
              </button>
            )}
            <button
              type="button"
              className="task-date"
              title="Change date (D)"
              aria-label="Change date, time or repeat"
              onClick={() => setPicking(true)}
            >
              <CalendarIcon />
            </button>
            <span className="task-tools-gap" aria-hidden />
            <button
              type="button"
              className="task-delete"
              title="Delete (⌫) — you can undo"
              aria-label={`Delete “${task.title}”`}
              onClick={() => void actions.remove(task)}
            >
              <TrashIcon />
            </button>
          </div>
        )}
      </div>
      {(snoozing || picking || moving) && (
        <div
          className="task-editing"
          // Keys pressed in here belong to the editor — never to the list
          // (so Backspace or X can't delete or finish the task by accident).
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === "Escape") {
              e.preventDefault();
              closeEditors();
            }
          }}
        >
          {snoozing && !task.done && (
            <SnoozeBar
              onSnooze={(kind) => {
                setSnoozing(false);
                void actions.snooze(task, kind);
              }}
            />
          )}
          {picking && (
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
              onClose={() => setPicking(false)}
            />
          )}
          {moving && (
            <ProjectPicker
              projects={projects}
              project={task.project}
              heading={task.heading}
              onPick={(project, heading) => {
                void actions.update(task, { project, heading });
                setMoving(false);
              }}
            />
          )}
          <div className="task-editing-foot">
            <span>{picking || moving ? "Changes save as you pick" : "Pick when to be reminded"}</span>
            <button type="button" className="task-editing-done" onClick={closeEditors}>
              Close
            </button>
          </div>
        </div>
      )}
    </li>
  );
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

/** Inline editor; Enter or clicking away saves, Esc cancels. */
function NotesEditor({ initial, onDone }: { initial: string; onDone: (notes: string | null) => void }) {
  const [value, setValue] = useState(initial);
  const done = useRef(false);
  const finish = (v: string | null) => {
    if (done.current) return;
    done.current = true;
    onDone(v);
  };
  return (
    <input
      className="task-notes-edit"
      autoFocus
      value={value}
      maxLength={2000}
      placeholder="Add a description, link or detail…"
      aria-label="Description"
      onChange={(e) => setValue(e.target.value)}
      onBlur={() => finish(value)}
      onKeyDown={(e) => {
        if (e.key === "Enter") finish(value);
        if (e.key === "Escape") {
          e.stopPropagation();
          finish(null);
        }
      }}
    />
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
