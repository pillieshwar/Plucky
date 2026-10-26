import { useMemo } from "react";
import { dayMarks } from "../lib/agenda";
import { addDays, parseISODate, toISODate } from "../lib/dates";
import type { DragState } from "../lib/useTaskDrag";
import type { Task } from "../lib/types";

/**
 * The next seven days in a row under Today. Click a day to open it in
 * Upcoming; drag a task onto one to move it there (its time stays).
 */
export function WeekStrip({
  tasks,
  now,
  locale,
  drag,
  onPick,
}: {
  tasks: Task[];
  now: Date;
  locale: string;
  drag: DragState | null;
  onPick: (iso: string) => void;
}) {
  const today = toISODate(now);
  const marks = useMemo(() => dayMarks(tasks, today), [tasks, today]);
  const days = useMemo(() => {
    const fmt = new Intl.DateTimeFormat(locale, { weekday: "short" });
    return Array.from({ length: 7 }, (_, i) => {
      const d = addDays(parseISODate(today), i);
      return { iso: toISODate(d), dow: fmt.format(d), num: d.getDate() };
    });
  }, [today, locale]);
  const over = drag?.over;
  return (
    <div className={drag ? "week-strip-row dragging" : "week-strip-row"} role="group" aria-label="This week">
      {days.map((d) => {
        const m = marks.get(d.iso);
        const dropHere = over?.iso === d.iso && over.hour === undefined;
        return (
          <button
            key={d.iso}
            type="button"
            data-iso={d.iso}
            className={["ws-day", d.iso === today ? "today" : "", dropHere ? "drop" : ""].filter(Boolean).join(" ")}
            onClick={() => onPick(d.iso)}
            aria-label={`${parseISODate(d.iso).toLocaleDateString(locale, { weekday: "long", month: "long", day: "numeric" })}${
              m ? `, ${m.open} open` : ""
            }`}
          >
            <span className="ws-dow">{d.dow}</span>
            <span className="ws-num">{d.num}</span>
            <span className="ws-dot" aria-hidden style={m ? undefined : { visibility: "hidden" }} />
          </button>
        );
      })}
    </div>
  );
}
