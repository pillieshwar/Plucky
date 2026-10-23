import { useEffect, useMemo, useState } from "react";
import { agendaHeading, dayMarks, weekRows } from "../lib/agenda";
import { api, onCalendarChanged } from "../lib/api";
import { addDays, parseISODate, toISODate } from "../lib/dates";
import { holidaysByDay } from "../lib/holidays";
import { dropPatch } from "../lib/plan";
import type { TaskActions } from "../lib/taskActions";
import type { CalendarEvent, NewTask, Task } from "../lib/types";
import { useTaskDrag } from "../lib/useTaskDrag";
import { AddTaskForm } from "./AddTaskForm";
import { DayPlan } from "./DayPlan";
import { DragGhost } from "./DragGhost";

interface Props {
  tasks: Task[];
  day: string;
  onDay: (iso: string) => void;
  now: Date;
  locale: string;
  weekStart: number;
  actions: TaskActions;
  adding: boolean;
  onAdding: (on: boolean) => void;
  onAdd: (task: NewTask) => Promise<void>;
  /** Show a task in the list. */
  onOpen: (task: Task) => void;
}

/**
 * The panel's week: seven days across the top, the chosen day in hour blocks
 * below. Drag a task onto another day to move it there (it keeps its time),
 * or onto another hour to re-time it.
 */
export function WeekView({ tasks, day, onDay, now, locale, weekStart, actions, adding, onAdding, onAdd, onOpen }: Props) {
  const today = toISODate(now);
  const days = weekRows(day, weekStart, 1);
  const from = days[0].iso;
  const to = days[6].iso;
  const labels = useMemo(() => {
    const fmt = new Intl.DateTimeFormat(locale, { weekday: "short" });
    return days.map((c) => fmt.format(parseISODate(c.iso)));
    // The weekday names only change with the week's first day.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [locale, weekStart]);
  const marks = useMemo(() => dayMarks(tasks, today), [tasks, today]);
  const undated = useMemo(() => tasks.filter((t) => !t.done && !t.due_date), [tasks]);
  const [showUndated, setShowUndated] = useState(false);
  const [events, setEvents] = useState<CalendarEvent[]>([]);
  const [eventsKey, setEventsKey] = useState(0);
  const heading = agendaHeading(day, today, locale);
  const thisWeek = today >= from && today <= to;

  const drag = useTaskDrag((task, target) => {
    const patch = dropPatch(task, target);
    if (patch) void actions.reschedule(task, patch);
  });

  useEffect(() => {
    let live = true;
    api
      .calendarEvents(from, to)
      .then((e) => live && setEvents(e))
      .catch(() => live && setEvents([]));
    return () => {
      live = false;
    };
  }, [from, to, eventsKey]);
  useEffect(() => {
    const sub = onCalendarChanged(() => setEventsKey((k) => k + 1));
    return () => void sub.then((u) => u());
  }, []);
  const holidays = useMemo(() => holidaysByDay(events, from, to), [events, from, to]);

  const shift = (n: number) => onDay(toISODate(addDays(parseISODate(day), n)));
  const over = drag.drag?.over;

  return (
    <div className={drag.drag ? "week-view dragging" : "week-view"}>
      <div className="week-nav">
        <button type="button" className="week-step" onClick={() => shift(-7)} aria-label="Previous week" title="Previous week">
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8">
            <path d="M10 3.5 5.5 8l4.5 4.5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
        <div className="week-strip" role="group" aria-label="This week">
          {days.map((c, i) => {
            const m = marks.get(c.iso);
            const holiday = holidays.get(c.iso);
            const dropHere = over?.iso === c.iso && over.hour === undefined;
            return (
              <button
                key={c.iso}
                type="button"
                data-iso={c.iso}
                className={[
                  "wk-day",
                  c.iso === today ? "today" : "",
                  c.iso === day ? "on" : "",
                  c.iso < today ? "past" : "",
                  dropHere ? "drop" : "",
                ]
                  .filter(Boolean)
                  .join(" ")}
                onClick={() => onDay(c.iso)}
                aria-pressed={c.iso === day}
                aria-label={`${parseISODate(c.iso).toLocaleDateString(locale, { weekday: "long", month: "long", day: "numeric" })}${
                  holiday ? `, ${holiday.join(", ")}` : ""
                }${m ? `, ${m.open} open` : ""}`}
                title={holiday?.join(", ")}
              >
                <span className="wk-dow">{labels[i]}</span>
                <span className="wk-num">{c.day}</span>
                <span className="wk-dots" aria-hidden>
                  {m && <span className={m.overdue ? "wk-dot late" : "wk-dot"} />}
                  {holiday && <span className="wk-dot holiday" />}
                </span>
              </button>
            );
          })}
        </div>
        <button type="button" className="week-step" onClick={() => shift(7)} aria-label="Next week" title="Next week">
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8">
            <path d="M6 3.5 10.5 8 6 12.5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
      </div>

      <div className="week-day-head">
        <h2>
          {heading.lead && <span className="lead">{heading.lead} · </span>}
          {parseISODate(day).toLocaleDateString(locale, { weekday: "short", month: "short", day: "numeric" })}
        </h2>
        {day !== today && (
          <button type="button" className="week-today" onClick={() => onDay(today)}>
            {thisWeek ? "Today" : "This week"}
          </button>
        )}
        <button
          type="button"
          className={adding ? "add-task-btn small on" : "add-task-btn small"}
          onClick={() => onAdding(!adding)}
          aria-expanded={adding}
          title="Add a task (A)"
        >
          <span aria-hidden>+</span> Add
        </button>
      </div>

      {adding && (
        <AddTaskForm
          locale={locale}
          defaultDay={day}
          placeholder="What needs doing? Try “call Sam 3pm”"
          onAdd={async (t) => {
            await onAdd(t);
            onAdding(false);
          }}
          onCancel={() => onAdding(false)}
        />
      )}

      {undated.length > 0 && (
        <div className="week-undated">
          <button
            type="button"
            className="week-undated-toggle"
            onClick={() => setShowUndated((s) => !s)}
            aria-expanded={showUndated}
          >
            {showUndated ? "Hide" : "Plan"} {undated.length} without a date
            <span aria-hidden>{showUndated ? " ▴" : " ▾"}</span>
          </button>
          {showUndated && (
            <div className="week-undated-list">
              {undated.map((t) => (
                <button
                  key={t.id}
                  type="button"
                  className={drag.drag?.task.id === t.id ? "undated-chip lifted" : "undated-chip"}
                  onPointerDown={(e) => drag.start(e, t)}
                  onClick={() => !drag.wasDrag() && onOpen(t)}
                  title="Drag onto a day or an hour"
                >
                  {t.title}
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      <DayPlan
        tasks={tasks}
        day={day}
        today={today}
        now={now}
        locale={locale}
        events={events}
        actions={actions}
        drag={drag}
        onAdd={onAdd}
        onOpen={onOpen}
      />
      {drag.drag && <DragGhost drag={drag.drag} now={now} locale={locale} />}
    </div>
  );
}
