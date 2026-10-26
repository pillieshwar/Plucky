import { type CSSProperties, type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { api, onCalendarChanged } from "../lib/api";
import { useProjectColors } from "../lib/colors";
import { addDays, parseISODate, relativeLabel, toISODate } from "../lib/dates";
import { holidaysByDay } from "../lib/holidays";
import { eventsForDay, hourLabel, planFor } from "../lib/plan";
import { timeLabel } from "../lib/schedule";
import type { TaskActions } from "../lib/taskActions";
import type { TaskDrag } from "../lib/useTaskDrag";
import type { CalendarEvent, NewTask, Task } from "../lib/types";
import { NewTaskField } from "./DayPlan";

interface Props {
  tasks: Task[];
  /** The first of the seven days shown. */
  day: string;
  today: string;
  now: Date;
  locale: string;
  actions: TaskActions;
  drag: TaskDrag;
  onAdd: (task: NewTask) => Promise<void>;
  onOpen: (task: Task) => void;
  openId: number | null;
}

/** Seven days from `day` on: Upcoming looks ahead from today, not back to the week's start. */
export function sevenDays(day: string): string[] {
  const d = parseISODate(day);
  return Array.from({ length: 7 }, (_, i) => toISODate(addDays(d, i)));
}

/** Where the inline new-task field is: a day and an hour, or the day's Any time. */
type AddAt = { iso: string; hour: number | "any" } | null;

/**
 * Full screen's Calendar: the whole week as a calendar. Tasks sit in the
 * hour of their time beside calendar events; untimed ones in Any time. Drag
 * a task to another day or hour, click an empty hour to add one there.
 */
export function WeekGrid({ tasks, day, today, now, locale, actions, drag, onAdd, onOpen, openId }: Props) {
  const colors = useProjectColors();
  const days = sevenDays(day);
  const from = days[0];
  const to = days[6];
  const [events, setEvents] = useState<CalendarEvent[]>([]);
  const [eventsKey, setEventsKey] = useState(0);
  const [addAt, setAddAt] = useState<AddAt>(null);
  const [completing, setCompleting] = useState<Set<number>>(new Set());
  const bodyRef = useRef<HTMLDivElement>(null);
  const over = drag.drag?.over;

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

  const cols = useMemo(
    () => days.map((iso) => ({ iso, plan: planFor(tasks, iso, today), evs: eventsForDay(events, iso) })),
    // `days` is derived from `from`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [tasks, events, from, today],
  );
  const holidays = useMemo(() => holidaysByDay(events, from, to), [events, from, to]);
  // The whole day, midnight to 11 PM: scrolling never runs out of hours, so
  // the calendar always reaches the bottom of the window.
  const hours = useMemo(() => Array.from({ length: 24 }, (_, i) => i), []);

  // Open on the morning (or now, this week).
  useEffect(() => {
    const box = bodyRef.current;
    if (!box) return;
    const target = days.includes(today) ? Math.max(now.getHours() - 2, hours[0]) : Math.max(8, hours[0]);
    const row = box.querySelector<HTMLElement>(`[data-row="${target}"]`);
    box.scrollTop = row ? row.offsetTop : 0;
    setAddAt(null);
    // Only when the week changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [from]);

  const weekday = useMemo(() => new Intl.DateTimeFormat(locale, { weekday: "short" }), [locale]);

  function complete(t: Task) {
    setCompleting((s) => new Set(s).add(t.id));
    const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    window.setTimeout(() => {
      void actions.setDone(t, true).finally(() =>
        setCompleting((s) => {
          const n = new Set(s);
          n.delete(t.id);
          return n;
        }),
      );
    }, reduce ? 0 : 380);
  }

  const chip = (t: Task, iso: string) => {
    const late = t.due_date !== iso;
    const odd = t.due_time && !t.due_time.endsWith(":00");
    return (
      <div
        key={t.id}
        className={[
          "wg-task",
          late ? "late" : "",
          t.deadline && t.deadline <= iso ? "deadline" : "",
          completing.has(t.id) ? "completing" : "",
          openId === t.id ? "picked" : "",
          drag.drag?.task.id === t.id ? "lifted" : "",
        ]
          .filter(Boolean)
          .join(" ")}
        style={t.project && colors[t.project] ? ({ "--pc": colors[t.project] } as CSSProperties) : undefined}
        onPointerDown={(e) => drag.start(e, t)}
      >
        <button type="button" className="plan-check" data-nodrag onClick={() => complete(t)} aria-label={`Mark “${t.title}” done`}>
          <svg width="9" height="9" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2.6">
            <path d="M3.5 8.5 6.5 11.5 12.5 4.5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
        <button type="button" className="wg-title" onClick={() => !drag.wasDrag() && onOpen(t)} title={`${t.title}\nDrag to another hour or day`}>
          {odd && <span className="wg-time">{timeLabel(t.due_time!, locale)} </span>}
          {t.title}
          {late && t.due_date && <span className="wg-late"> · {relativeLabel(t.due_date, now, locale)}</span>}
        </button>
      </div>
    );
  };

  const eventChip = (e: CalendarEvent, iso: string) => {
    const at = e.all_day
      ? null
      : e.start.slice(0, 10) < iso
        ? `until ${timeLabel(e.end.slice(11, 16), locale)}`
        : `${timeLabel(e.start.slice(11, 16), locale)} – ${timeLabel(e.end.slice(11, 16), locale)}`;
    return (
      <div
        key={`${e.id}${e.start}`}
        className="wg-event"
        style={{ "--ev": e.color ?? "var(--faint)" } as CSSProperties}
        title={`${e.title || "Busy"}${at ? ` · ${at}` : ""} · ${e.calendar}`}
      >
        <span className="wg-event-title">{e.title || "Busy"}</span>
        {at && <span className="wg-event-time">{at}</span>}
      </div>
    );
  };

  const field = (iso: string, hour: number | "any") => (
    <NewTaskField
      placeholder={hour === "any" ? "New task…" : `New task at ${hourLabel(hour, locale)}…`}
      onDone={async (title) => {
        setAddAt(null);
        if (!title) return;
        await onAdd({
          title,
          due_date: iso,
          due_time: hour === "any" ? null : `${String(hour).padStart(2, "0")}:00`,
          source_text: null,
        });
      }}
    />
  );

  const nowHour = now.getHours();
  return (
    <div className="week-grid">
      <div className="wg-row wg-days">
        <span />
        {cols.map(({ iso }) => {
          const d = parseISODate(iso);
          const hol = holidays.get(iso);
          return (
            <div
              key={iso}
              className={["wg-day", iso === today ? "today" : "", iso < today ? "past" : "", over?.iso === iso && over.hour === undefined ? "drop" : ""]
                .filter(Boolean)
                .join(" ")}
              data-iso={iso}
              title={hol?.join(", ")}
            >
              <span className="wg-dow">{weekday.format(d)}</span>
              <span className="wg-num">{d.getDate()}</span>
              {hol && <span className="wg-hol" aria-label={hol.join(", ")} />}
            </div>
          );
        })}
      </div>
      <div className="wg-row wg-any">
        <span className="wg-hour">Any time</span>
        {cols.map(({ iso, plan, evs }) => (
          <div
            key={iso}
            className={["wg-cell", iso === today ? "today" : "", over?.iso === iso && over.hour === null ? "drop" : ""].filter(Boolean).join(" ")}
            data-iso={iso}
            data-hour="any"
            onClick={(e) => {
              if (e.target === e.currentTarget && !addAt) setAddAt({ iso, hour: "any" });
            }}
          >
            {evs.allDay.map((e) => eventChip(e, iso))}
            {plan.anytime.map((t) => chip(t, iso))}
            {addAt?.iso === iso && addAt.hour === "any" && field(iso, "any")}
          </div>
        ))}
      </div>
      <div className="wg-body" ref={bodyRef} data-autoscroll>
        {hours.map((h) => (
          <div key={h} className="wg-row" data-row={h}>
            <span className="wg-hour">{hourLabel(h, locale)}</span>
            {cols.map(({ iso, plan, evs }) => {
              const isToday = iso === today;
              const past = iso < today || (isToday && h < nowHour);
              return (
                <div
                  key={iso}
                  className={[
                    "wg-cell",
                    isToday ? "today" : "",
                    past ? "past" : "",
                    over?.iso === iso && over.hour === h ? "drop" : "",
                  ]
                    .filter(Boolean)
                    .join(" ")}
                  data-iso={iso}
                  data-hour={h}
                  onClick={(e) => {
                    if (e.target === e.currentTarget && !addAt) setAddAt({ iso, hour: h });
                  }}
                >
                  {(evs.byHour.get(h) ?? []).map((e) => eventChip(e, iso))}
                  {(plan.byHour.get(h) ?? []).map((t) => chip(t, iso))}
                  {addAt?.iso === iso && addAt.hour === h && field(iso, h)}
                  {isToday && h === nowHour && <span className="plan-now" style={{ top: `${(now.getMinutes() / 60) * 100}%` }} aria-hidden />}
                </div>
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * Beside the week: tasks with no date yet, to drag onto a day or an hour,
 * and the deadlines coming up this week.
 */
export function WeekSide({
  tasks,
  days,
  today,
  now,
  locale,
  drag,
  onOpen,
  month,
}: {
  tasks: Task[];
  days: string[];
  today: string;
  now: Date;
  locale: string;
  drag: TaskDrag;
  onOpen: (task: Task) => void;
  /** The month at a glance, above the rest. */
  month?: ReactNode;
}) {
  const undated = tasks.filter((t) => !t.done && !t.due_date && !t.someday && !t.paused);
  const deadlines = tasks
    .filter((t) => !t.done && t.deadline && t.deadline >= days[0] && t.deadline <= days[6])
    .sort((a, b) => (a.deadline ?? "").localeCompare(b.deadline ?? ""));
  return (
    <aside className="side-pane week-side" aria-label="Not planned yet">
      {month}
      <div className="sp-head">
        <span className="sp-title">No date yet</span>
        <span className="sp-count">{undated.length}</span>
      </div>
      <div className="sp-body" data-autoscroll>
        <p className="sp-hint">Drag onto a day or an hour to plan it.</p>
        {undated.length === 0 && <p className="sp-empty">Everything has a day.</p>}
        {undated.map((t) => (
          <div
            key={t.id}
            className={drag.drag?.task.id === t.id ? "ws-card lifted" : "ws-card"}
            onPointerDown={(e) => drag.start(e, t)}
          >
            <button type="button" className="ws-title" onClick={() => !drag.wasDrag() && onOpen(t)}>
              {t.title}
            </button>
            {t.project && <span className="ws-meta">{t.project}</span>}
          </div>
        ))}
        {deadlines.length > 0 && (
          <>
            <h3 className="sp-sub">Deadlines this week</h3>
            {deadlines.map((t) => (
              <button key={t.id} type="button" className="ws-deadline" onClick={() => onOpen(t)}>
                <span>{t.title}</span>
                <span className={t.deadline! <= today ? "late" : ""}>{relativeLabel(t.deadline!, now, locale)}</span>
              </button>
            ))}
          </>
        )}
      </div>
    </aside>
  );
}
