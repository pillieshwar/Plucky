import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { agendaFor, agendaHeading, dayMarks, overdueLabel, undatedCount, weekRows } from "../lib/agenda";
import { api, onPopoverShown, onShortcutsChanged, onTasksChanged } from "../lib/api";
import { monthGrid, monthLabel, shiftMonth, weekStartForLocale, weekdayLabels, type DayCell } from "../lib/calendar";
import { addDays, parseISODate, toISODate } from "../lib/dates";
import { formatShortcut } from "../lib/shortcuts";
import type { Task } from "../lib/types";
import { safeLocale } from "../lib/locale";

const LOCALE = safeLocale();

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
  const inputRef = useRef<HTMLInputElement>(null);

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
    const subs = [
      onTasksChanged(() => void load()),
      onPopoverShown(reset),
      onShortcutsChanged((s) => setShortcut(formatShortcut(s.capture))),
    ];
    return () => subs.forEach((p) => void p.then((u) => u()));
  }, [load, reset]);

  useEffect(() => {
    if (adding) inputRef.current?.focus();
  }, [adding]);

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
    try {
      await api.updateTask(t.id, { done });
    } catch (e) {
      setError(String(e));
      void load();
    }
  }

  async function add(e: FormEvent) {
    e.preventDefault();
    const title = draft.trim();
    if (!title) return;
    try {
      await api.addTask({ title, due_date: selected, source_text: null });
      setDraft("");
      setAdding(false);
    } catch (err) {
      setError(String(err));
    }
  }

  function onKey(e: KeyboardEvent) {
    const target = e.target as HTMLElement;
    const typing = target.tagName === "INPUT";
    if (e.key === "Escape") {
      e.preventDefault();
      if (adding) setAdding(false);
      else void api.hidePopover();
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

  return (
    <div className="pop" key={openKey} onKeyDown={onKey} tabIndex={-1}>
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
          <IconButton label="Open Pluck" onClick={() => void api.openMain(null, null)}>
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
            ]
              .filter(Boolean)
              .join(" ");
            return (
              <button
                key={c.iso}
                type="button"
                className={cls}
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

        {error && <p className="pop-error">{error}</p>}

        <ul className="pop-list">
          {agenda.overdue.map((t) => (
            <Row key={t.id} task={t} meta={overdueLabel(t.due_date!, today)} tone="late" onToggle={toggleDone} />
          ))}
          {agenda.due.map((t) => (
            <Row key={t.id} task={t} meta={snippet(t.source_text)} tone="due" onToggle={toggleDone} />
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
                  <Row key={t.id} task={t} meta={null} tone="done" onToggle={toggleDone} />
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
            <kbd>{shortcut}</kbd> capture
          </span>
        )}
      </footer>
    </div>
  );
}

function Row({
  task,
  meta,
  tone,
  onToggle,
}: {
  task: Task;
  meta: string | null;
  tone: "late" | "due" | "done";
  onToggle: (t: Task) => void;
}) {
  return (
    <li className={`pop-row ${tone}${task.done ? " checked" : ""}`}>
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
        onClick={() => void api.openMain(task.id, "tasks")}
        title="Open in Pluck"
      >
        <span className="pop-title">{task.title}</span>
        {meta && <span className="pop-meta">{meta}</span>}
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
