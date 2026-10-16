import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import { agendaFor, agendaHeading, dayMarks, overdueLabel, undatedCount, weekRows } from "../lib/agenda";
import { api, onCalendarChanged, onCapture, onPopoverShown, onShortcutsChanged, onTasksChanged, onUpdateStatus } from "../lib/api";
import { processCapture } from "../lib/capture";
import { CaptureCard, type CaptureState } from "../components/CaptureCard";
import { monthGrid, monthLabel, shiftMonth, weekStartForLocale, weekdayLabels, type DayCell } from "../lib/calendar";
import { addDays, dayOrderForLocale, parseISODate, relativeLabel, toISODate } from "../lib/dates";
import { findSchedule, repeatLabel, repeatShort, timeLabel } from "../lib/schedule";
import { formatShortcut } from "../lib/shortcuts";
import { taskActions } from "../lib/taskActions";
import { sourceLabel } from "../lib/taskText";
import type { CalendarEvent, NewTask, Task, UpdateStatus } from "../lib/types";
import { safeLocale } from "../lib/locale";
import { Toasts, useToasts } from "../components/Toasts";
import { DueNowCard } from "../components/DueNowCard";
import { dueChip, dueNow, type DueChip } from "../lib/due";

const LOCALE = safeLocale();
const ORDER = dayOrderForLocale(LOCALE);

interface Drag {
  task: Task;
  x: number;
  y: number;
  /** Day under the pointer. */
  over: string | null;
}

/**
 * The menu-bar popover: a two-week strip that expands into a month, and the
 * selected day's agenda. Overdue tasks surface on today. Tasks can be checked
 * off and added without opening the main panel.
 */
export default function Popover() {
  const [now, setNow] = useState(() => new Date());
  const today = toISODate(now);
  const [selected, setSelected] = useState(today);
  // First day shown by the two-week strip; it only moves when the selection
  // leaves the visible fortnight, so clicking a day never shifts the grid.
  const [stripAnchor, setStripAnchor] = useState(today);
  const [expanded, setExpanded] = useState(false);
  const [view, setView] = useState(() => ({ year: now.getFullYear(), month: now.getMonth() }));
  const [tasks, setTasks] = useState<Task[]>([]);
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState("");
  const [showDone, setShowDone] = useState(false);
  const [shortcut, setShortcut] = useState<string>("");
  const [error, setError] = useState<string | null>(null);
  const [openKey, setOpenKey] = useState(0);
  const [update, setUpdate] = useState<UpdateStatus>({ state: "idle" });
  const [drag, setDrag] = useState<Drag | null>(null);
  const pressed = useRef<{ task: Task; x: number; y: number } | null>(null);
  const dragged = useRef(false);
  const dragRef = useRef<Drag | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const { toasts, show, dismiss, undoLast } = useToasts();
  // A selection captured with the shortcut (or Add to Plucky), reviewed
  // right here under the menu-bar icon.
  const [capture, setCapture] = useState<CaptureState | null>(null);
  const captureSeq = useRef(0);
  // Events from the Calendar connector for the selected day (empty if off).
  const [events, setEvents] = useState<CalendarEvent[]>([]);
  const [eventsKey, setEventsKey] = useState(0);
  const actions = useMemo(() => taskActions(show, LOCALE), [show]);

  const weekStart = useMemo(() => weekStartForLocale(LOCALE), []);
  const labels = useMemo(() => weekdayLabels(LOCALE, weekStart), [weekStart]);

  const load = useCallback(async () => {
    try {
      setTasks(await api.listTasks(toISODate(new Date())));
      setError(null);
    } catch (e) {
      setError(String(e));
    }
  }, []);

  // Every time the popover opens: back to today, fresh data.
  const reset = useCallback(() => {
    const n = new Date();
    setNow(n);
    setSelected(toISODate(n));
    setStripAnchor(toISODate(n));
    setView({ year: n.getFullYear(), month: n.getMonth() });
    setExpanded(false);
    setAdding(false);
    setDraft("");
    setShowDone(false);
    setOpenKey((k) => k + 1);
    void load();
  }, [load]);

  useEffect(() => {
    void load();
    api
      .getShortcuts()
      .then((s) => setShortcut(formatShortcut(s.capture)))
      .catch(() => undefined);
    api
      .updateStatus()
      .then(setUpdate)
      .catch(() => undefined);
    const subs = [
      onTasksChanged(() => void load()),
      onPopoverShown(reset),
      onShortcutsChanged((s) => setShortcut(formatShortcut(s.capture))),
      onUpdateStatus(setUpdate),
      onCapture((r) => {
        const seq = ++captureSeq.current;
        void api
          .status()
          .catch(() => null)
          .then((st) => processCapture(r, st, setCapture, () => seq === captureSeq.current));
      }),
    ];
    return () => subs.forEach((p) => void p.then((u) => u()));
  }, [load, reset]);

  useEffect(() => {
    let live = true;
    api
      .calendarEvents(selected, selected)
      .then((e) => live && setEvents(e))
      .catch(() => live && setEvents([]));
    return () => {
      live = false;
    };
  }, [selected, openKey, eventsKey]);

  useEffect(() => {
    const sub = onCalendarChanged(() => setEventsKey((k) => k + 1));
    return () => void sub.then((u) => u());
  }, []);

  // Keep the popover open while a capture is being reviewed.
  useEffect(() => {
    void api.setPopoverPinned(capture !== null).catch(() => undefined);
  }, [capture]);

  function endCapture() {
    captureSeq.current++;
    setCapture(null);
    void api.hidePopover();
  }

  async function saveCapture(task: NewTask) {
    try {
      await api.addTask(task);
      captureSeq.current++;
      setCapture(null);
      show(task.due_date ? `Added for ${relativeLabel(task.due_date, new Date(), LOCALE).toLowerCase()}` : "Task added");
      // Let the confirmation show for a moment, then get out of the way.
      window.setTimeout(() => void api.hidePopover(), 1100);
    } catch (e) {
      setError(String(e));
    }
  }

  useEffect(() => {
    if (adding) inputRef.current?.focus();
  }, [adding]);

  // Keyboard shortcuts work as soon as the popover opens.
  useEffect(() => {
    rootRef.current?.focus();
  }, [openKey]);

  const marks = useMemo(() => dayMarks(tasks, today), [tasks, today]);
  const agenda = useMemo(() => agendaFor(tasks, selected, today), [tasks, selected, today]);
  const undated = useMemo(() => undatedCount(tasks), [tasks]);
  const heading = agendaHeading(selected, today, LOCALE);

  const stripDays = weekRows(stripAnchor, weekStart, 2);
  const cells: DayCell[] = expanded ? monthGrid(view.year, view.month, weekStart) : stripDays;
  const shownMonth = expanded
    ? view
    : { year: parseISODate(selected).getFullYear(), month: parseISODate(selected).getMonth() };

  function select(iso: string) {
    setSelected(iso);
    if (!stripDays.some((c) => c.iso === iso)) setStripAnchor(iso);
    const d = parseISODate(iso);
    if (expanded && (d.getFullYear() !== view.year || d.getMonth() !== view.month)) {
      setView({ year: d.getFullYear(), month: d.getMonth() });
    }
    setAdding(false);
  }

  function step(n: number) {
    if (expanded) {
      const v = shiftMonth(view.year, view.month, n);
      setView(v);
      // Keep the selection in the visible month.
      const s = parseISODate(selected);
      const day = Math.min(s.getDate(), new Date(v.year, v.month + 1, 0).getDate());
      setSelected(toISODate(new Date(v.year, v.month, day)));
    } else {
      setSelected(toISODate(addDays(parseISODate(selected), 7 * n)));
      setStripAnchor(toISODate(addDays(parseISODate(stripAnchor), 7 * n)));
    }
  }

  function toggleExpanded() {
    const s = parseISODate(selected);
    setView({ year: s.getFullYear(), month: s.getMonth() });
    // Collapsing shows the fortnight around the day picked in month view.
    if (expanded) setStripAnchor(selected);
    setExpanded((e) => !e);
  }

  async function toggleDone(t: Task) {
    // Decide once, before anything async can change `t`.
    const done = !t.done;
    const completedAt = done ? new Date().toISOString() : null;
    // Optimistic: tick immediately, then persist.
    setTasks((ts) => ts.map((x) => (x.id === t.id ? { ...x, done, completed_at: completedAt } : x)));
    await actions.setDone(t, done);
  }

  // Typed dates win ("dentist fri 3pm"); otherwise the selected day.
  const typed = useMemo(() => (draft.trim() ? findSchedule(draft, now, ORDER) : null), [draft, now]);

  async function add(e: FormEvent) {
    e.preventDefault();
    const title = (typed?.title || draft).trim();
    if (!title) return;
    const day = typed?.date ?? selected;
    try {
      await api.addTask({
        title,
        due_date: day,
        due_time: typed?.date ? typed.time : null,
        recurrence: typed?.repeat ?? null,
        source_text: null,
      });
      setDraft("");
      setAdding(false);
      if (day !== selected) show(`Added for ${relativeLabel(day, new Date(), LOCALE).toLowerCase()}`);
    } catch (err) {
      setError(String(err));
    }
  }

  // ── Drag a task onto a day to reschedule it ──
  function onRowPointerDown(e: ReactPointerEvent, task: Task) {
    if (e.button !== 0 || task.done) return;
    if ((e.target as HTMLElement).closest(".pop-check")) return;
    pressed.current = { task, x: e.clientX, y: e.clientY };
    dragged.current = false;
  }

  useEffect(() => {
    const move = (e: PointerEvent) => {
      const p = pressed.current;
      if (!p) return;
      if (!dragged.current && Math.hypot(e.clientX - p.x, e.clientY - p.y) < 6) return;
      dragged.current = true;
      const el = document.elementFromPoint(e.clientX, e.clientY) as HTMLElement | null;
      const over = el?.closest<HTMLElement>("[data-iso]")?.dataset.iso ?? null;
      dragRef.current = { task: p.task, x: e.clientX, y: e.clientY, over };
      setDrag(dragRef.current);
    };
    const up = () => {
      const d = dragRef.current;
      pressed.current = null;
      dragRef.current = null;
      setDrag(null);
      if (d?.over && d.over !== d.task.due_date) void actions.reschedule(d.task, { due_date: d.over });
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
    };
  }, [actions]);

  function openTask(task: Task) {
    // A drag ends with a click on the row; don't treat it as one.
    if (dragged.current) {
      dragged.current = false;
      return;
    }
    void api.openMain(task.id, "tasks");
  }

  function onKey(e: KeyboardEvent) {
    const target = e.target as HTMLElement;
    const typing = target.tagName === "INPUT";
    if (capture) {
      if (e.key === "Escape" && !e.defaultPrevented) {
        e.preventDefault();
        endCapture();
      }
      return;
    }
    if (e.key === "Escape") {
      e.preventDefault();
      if (adding) setAdding(false);
      else void api.hidePopover();
      return;
    }
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "z" && !typing) {
      if (undoLast()) e.preventDefault();
      return;
    }
    if (typing) return;
    const moves: Record<string, number> = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 };
    if (e.key in moves) {
      e.preventDefault();
      select(toISODate(addDays(parseISODate(selected), moves[e.key])));
    } else if (e.key === "n" || e.key === "+") {
      e.preventDefault();
      setAdding(true);
    } else if (e.key === "t") {
      e.preventDefault();
      select(today);
    }
  }

  const empty = agenda.overdue.length === 0 && agenda.due.length === 0;

  if (capture) {
    return (
      <div ref={rootRef} className="pop pop-capture" key={openKey} onKeyDown={onKey} tabIndex={-1}>
        <header className="pop-capture-head">
          <span className="pop-capture-title">Add to Plucky</span>
          <IconButton label="Discard (Esc)" onClick={endCapture}>
            <path d="M4 4l8 8M12 4l-8 8" />
          </IconButton>
        </header>
        <div className="pop-capture-body">
          <CaptureCard
            state={capture}
            now={new Date()}
            onSave={saveCapture}
            onCancel={endCapture}
            onGrantAccess={() => {
              void api.requestAccessibility();
              endCapture();
            }}
          />
        </div>
        <Toasts toasts={toasts} onDismiss={dismiss} />
      </div>
    );
  }

  return (
    <div ref={rootRef} className={drag ? "pop dragging" : "pop"} key={openKey} onKeyDown={onKey} tabIndex={-1}>
      {update.state === "ready" && (
        <button type="button" className="pop-update" onClick={() => void api.installUpdate().catch((e) => setError(String(e)))}>
          Plucky {update.version} is ready · <strong>Restart to update</strong>
        </button>
      )}
      <header className="pop-head">
        <h1 className="pop-month">
          {monthLabel(LOCALE, shownMonth.year, shownMonth.month).replace(String(shownMonth.year), "").trim()}
          {shownMonth.year !== now.getFullYear() && <span className="pop-year"> {shownMonth.year}</span>}
        </h1>
        <div className="pop-actions">
          {selected !== today && (
            <button type="button" className="pop-today" onClick={() => select(today)}>
              Today
            </button>
          )}
          <IconButton label={expanded ? "Previous month" : "Previous week"} onClick={() => step(-1)}>
            <path d="M10 3.5 5.5 8l4.5 4.5" />
          </IconButton>
          <IconButton label={expanded ? "Next month" : "Next week"} onClick={() => step(1)}>
            <path d="M6 3.5 10.5 8 6 12.5" />
          </IconButton>
          <IconButton label="Add a task (N)" onClick={() => setAdding((a) => !a)} active={adding}>
            <path d="M8 3v10M3 8h10" />
          </IconButton>
          <IconButton label="Open Plucky" onClick={() => void api.openMain(null, null)}>
            <rect x="2.5" y="3" width="11" height="10" rx="2" />
            <path d="M9.5 3v10" />
          </IconButton>
        </div>
      </header>

      <div className="pop-cal">
        <div className="pop-grid" role="grid" aria-label="Calendar">
          {labels.map((l, i) => (
            <span key={`dow${i}`} className="pop-dow" aria-hidden>
              {l}
            </span>
          ))}
          {cells.map((c) => {
            const m = marks.get(c.iso);
            const cls = [
              "pop-day",
              c.inMonth ? "" : "out",
              c.iso === today ? "today" : "",
              c.iso === selected ? "on" : "",
              c.iso < today ? "past" : "",
              drag?.over === c.iso ? "drop" : "",
            ]
              .filter(Boolean)
              .join(" ");
            return (
              <button
                key={c.iso}
                type="button"
                className={cls}
                data-iso={c.iso}
                onClick={() => select(c.iso)}
                aria-pressed={c.iso === selected}
                aria-label={`${parseISODate(c.iso).toLocaleDateString(LOCALE, {
                  weekday: "long",
                  month: "long",
                  day: "numeric",
                })}${m ? `, ${m.open} open` : ""}`}
              >
                <span className="pop-num">{c.day}</span>
                <span className={m ? (m.overdue ? "pop-dot late" : "pop-dot") : "pop-dot none"} aria-hidden />
              </button>
            );
          })}
        </div>
        <button
          type="button"
          className={expanded ? "pop-expand up" : "pop-expand"}
          onClick={toggleExpanded}
          aria-label={expanded ? "Show two weeks" : "Show the whole month"}
          aria-expanded={expanded}
        >
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8">
            <path d="M3.5 6 8 10.5 12.5 6" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
      </div>

      <section className="pop-agenda" aria-label="Agenda">
        <h2 className="pop-ah">
          {heading.lead && <span className="lead">{heading.lead}</span>}
          {heading.lead && <span className="sep"> · </span>}
          <span>{heading.date}</span>
        </h2>

        {events.length > 0 && <EventList events={events} day={selected} now={now} />}

        {selected === today && (
          <DueNowCard tasks={dueNow(tasks, new Date())} actions={actions} now={new Date()} locale={LOCALE} compact />
        )}

        {adding && (
          <form className="pop-add" onSubmit={add}>
            <input
              ref={inputRef}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder={`New task for ${heading.lead ?? heading.date.split(",")[0]}…`}
              maxLength={200}
              aria-label="New task title"
            />
            <button type="submit" disabled={!draft.trim()}>
              Add
            </button>
          </form>
        )}
        {adding && typed?.date && (
          <p className="pop-typed">
            {[
              relativeLabel(typed.date, now, LOCALE),
              typed.time && timeLabel(typed.time, LOCALE),
              typed.repeat && repeatLabel(typed.repeat)?.toLowerCase(),
            ]
              .filter(Boolean)
              .join(" · ")}
          </p>
        )}
        {agenda.overdue.length > 1 && selected === today && (
          <button type="button" className="pop-move" onClick={() => void actions.moveAll(agenda.overdue, today)}>
            Move {agenda.overdue.length} overdue to today
          </button>
        )}

        {error && <p className="pop-error">{error}</p>}

        <ul className="pop-list">
          {agenda.overdue.map((t) => (
            <Row
              key={t.id}
              task={t}
              chip={dueChip(t, new Date(), LOCALE) ?? { tone: "overdue", label: overdueLabel(t.due_date!, today) }}
              meta={rowMeta(t).join(" · ") || null}
              tone="late"
              onToggle={toggleDone}
              onOpen={openTask}
              onPointerDown={onRowPointerDown}
              dragging={drag?.task.id === t.id}
            />
          ))}
          {agenda.due.map((t) => (
            <Row
              key={t.id}
              task={t}
              chip={dueChip(t, new Date(), LOCALE)}
              meta={rowMeta(t).join(" · ") || snippet(t.notes) || snippet(t.source_text)}
              tone={dueChip(t, new Date(), LOCALE)?.tone === "overdue" ? "late" : "due"}
              onToggle={toggleDone}
              onOpen={openTask}
              onPointerDown={onRowPointerDown}
              dragging={drag?.task.id === t.id}
            />
          ))}
        </ul>

        {empty && !adding && (
          <div className="pop-empty">
            <p className="big">{selected === today ? "You're all clear today." : "Nothing due this day."}</p>
            <p>
              <button type="button" className="pop-link" onClick={() => setAdding(true)}>
                Add a task
              </button>
              {shortcut && (
                <>
                  {" "}
                  or select text anywhere and press <kbd>{shortcut}</kbd>
                </>
              )}
            </p>
          </div>
        )}

        {agenda.done.length > 0 && (
          <div className="pop-done">
            <button type="button" className="pop-done-toggle" onClick={() => setShowDone((s) => !s)}>
              {showDone ? "Hide" : "Show"} completed · {agenda.done.length}
            </button>
            {showDone && (
              <ul className="pop-list">
                {agenda.done.map((t) => (
                  <Row key={t.id} task={t} chip={null} meta={null} tone="done" onToggle={toggleDone} onOpen={openTask} />
                ))}
              </ul>
            )}
          </div>
        )}
      </section>

      <footer className="pop-foot">
        {undated > 0 ? (
          <button type="button" className="pop-link" onClick={() => void api.openMain(null, "tasks")}>
            {undated} without a date
          </button>
        ) : (
          <span>All tasks scheduled</span>
        )}
        {shortcut && (
          <span className="pop-hint">
            {agenda.due.length + agenda.overdue.length > 0 ? "Drag a task onto a day to move it" : <><kbd>{shortcut}</kbd> capture</>}
          </span>
        )}
      </footer>
      <Toasts toasts={toasts} onDismiss={dismiss} />
      {drag && (
        <div
          className="pop-ghost"
          style={{ left: Math.max(8, Math.min(drag.x - 40, window.innerWidth - 236)), top: drag.y + 14 }}
          aria-hidden
        >
          {drag.task.title}
          {drag.over && <span> → {relativeLabel(drag.over, now, LOCALE)}</span>}
        </div>
      )}
    </div>
  );
}

/** Repeat and source, for the line under a title (time is in the chip). */
function rowMeta(t: Task): string[] {
  const parts: string[] = [];
  const r = repeatShort(t.recurrence);
  if (r) parts.push(r);
  const src = sourceLabel(t);
  if (src) parts.push(`from ${src}`);
  return parts;
}

function Row({
  task,
  chip,
  meta,
  tone,
  onToggle,
  onOpen,
  onPointerDown,
  dragging,
}: {
  task: Task;
  chip: DueChip | null;
  meta: string | null;
  tone: "late" | "due" | "done";
  onToggle: (t: Task) => void;
  onOpen: (t: Task) => void;
  onPointerDown?: (e: ReactPointerEvent, t: Task) => void;
  dragging?: boolean;
}) {
  return (
    <li
      className={`pop-row ${tone}${task.done ? " checked" : ""}${dragging ? " lifted" : ""}`}
      onPointerDown={onPointerDown ? (e) => onPointerDown(e, task) : undefined}
    >
      <button
        type="button"
        className="pop-check"
        onClick={() => onToggle(task)}
        aria-label={task.done ? `Mark “${task.title}” not done` : `Mark “${task.title}” done`}
        aria-pressed={task.done}
      >
        <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2.4">
          <path d="M3.5 8.5 6.5 11.5 12.5 4.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      <button
        type="button"
        className="pop-body"
        onClick={() => onOpen(task)}
        title="Open in Plucky · drag onto a day to move it"
      >
        <span className="pop-title">{task.title}</span>
        {(chip || meta) && (
          <span className="pop-meta">
            {chip && <span className={`due-chip ${chip.tone}`}>{chip.label}</span>}
            {meta && <span className="pop-meta-text">{meta}</span>}
          </span>
        )}
      </button>
    </li>
  );
}

function IconButton({
  label,
  onClick,
  active,
  children,
}: {
  label: string;
  onClick: () => void;
  active?: boolean;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      className={active ? "pop-icon on" : "pop-icon"}
      onClick={onClick}
      aria-label={label}
      title={label}
    >
      <svg
        width="16"
        height="16"
        viewBox="0 0 16 16"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        {children}
      </svg>
    </button>
  );
}

/** First line of the original selection, as context under the title. */
function snippet(source: string | null): string | null {
  if (!source) return null;
  const line = source.replace(/\s+/g, " ").trim();
  return line.length > 70 ? `${line.slice(0, 69)}…` : line || null;
}

/** The selected day's calendar events, above its tasks. */
function EventList({ events, day, now }: { events: CalendarEvent[]; day: string; now: Date }) {
  const [all, setAll] = useState(false);
  const shown = all ? events : events.slice(0, 4);
  const hhmm = (t: string) => timeLabel(t.slice(11, 16), LOCALE);
  const nowStr = `${toISODate(now)}T${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}:00`;
  return (
    <ul className="pop-events" aria-label="Calendar">
      {shown.map((e) => {
        const when = e.all_day
          ? "All day"
          : e.start.slice(0, 10) < day
            ? `Until ${hhmm(e.end)}`
            : e.end.slice(0, 10) > day
              ? `From ${hhmm(e.start)}`
              : `${hhmm(e.start)} – ${hhmm(e.end)}`;
        const past = !e.all_day && e.end <= nowStr;
        return (
          <li key={`${e.id}${e.start}`} className={past ? "pop-event past" : "pop-event"} title={e.calendar}>
            <span className="pop-event-bar" style={{ background: e.color ?? "var(--faint)" }} aria-hidden />
            <span className="pop-event-title">{e.title || "Busy"}</span>
            <span className="pop-event-time">{when}</span>
          </li>
        );
      })}
      {events.length > 4 && (
        <li>
          <button type="button" className="pop-event-more" onClick={() => setAll((a) => !a)}>
            {all ? "Show fewer" : `${events.length - 4} more event${events.length - 4 === 1 ? "" : "s"}`}
          </button>
        </li>
      )}
    </ul>
  );
}
