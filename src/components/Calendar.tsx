import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { monthGrid, monthLabel, shiftMonth, weekStartForLocale, weekdayLabels } from "../lib/calendar";
import { addDays, parseISODate, toISODate } from "../lib/dates";

interface Props {
  /** Selected day (YYYY-MM-DD) or null for "no date". */
  value: string | null;
  onChange: (iso: string | null) => void;
  onClose: () => void;
  now: Date;
  locale: string;
  /** Days before this are shown but can't be picked. */
  min?: string;
  /** Move keyboard focus into the grid when it opens (default true). */
  autoFocus?: boolean;
  /** Hide the Today / Tomorrow / No date row (when the parent shows its own). */
  hideQuick?: boolean;
  /** Keep it open after a day is picked (the parent has a Done button). */
  stayOpen?: boolean;
  /** Another day to show with a small dot (the deadline, or the planned day). */
  mark?: string | null;
  /** The chosen day is a deadline: shown in the deadline color. */
  flag?: boolean;
}

/**
 * An inline month calendar. It renders in the panel's own layout (never as a
 * floating popup), so it can't be cut off at the edge of the screen.
 */
export function Calendar({ value, onChange, onClose, now, locale, min, autoFocus = true, hideQuick = false, stayOpen = false, mark = null, flag = false }: Props) {
  const today = toISODate(now);
  const start = parseISODate(value ?? today);
  const [view, setView] = useState({ year: start.getFullYear(), month: start.getMonth() });
  const [focus, setFocus] = useState(value ?? today);
  const gridRef = useRef<HTMLDivElement>(null);

  const weekStart = useMemo(() => weekStartForLocale(locale), [locale]);
  const labels = useMemo(() => weekdayLabels(locale, weekStart), [locale, weekStart]);
  const cells = monthGrid(view.year, view.month, weekStart);

  // Move keyboard focus to the focused day after navigation.
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      if (!autoFocus) return;
    }
    gridRef.current?.querySelector<HTMLButtonElement>(`[data-iso="${focus}"]`)?.focus();
  }, [focus, view, autoFocus]);

  function moveFocus(iso: string) {
    const d = parseISODate(iso);
    if (d.getFullYear() !== view.year || d.getMonth() !== view.month) {
      setView({ year: d.getFullYear(), month: d.getMonth() });
    }
    setFocus(iso);
  }

  function page(n: number) {
    setView((v) => shiftMonth(v.year, v.month, n));
  }

  function pick(iso: string | null) {
    onChange(iso);
    if (iso) setFocus(iso);
    if (!stayOpen) onClose();
  }

  function onKey(e: KeyboardEvent) {
    const step: Record<string, number> = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 };
    if (e.key in step) {
      e.preventDefault();
      moveFocus(toISODate(addDays(parseISODate(focus), step[e.key])));
    } else if (e.key === "PageUp" || e.key === "PageDown") {
      e.preventDefault();
      const d = parseISODate(focus);
      const t = shiftMonth(d.getFullYear(), d.getMonth(), e.key === "PageUp" ? -1 : 1);
      const day = Math.min(d.getDate(), new Date(t.year, t.month + 1, 0).getDate());
      moveFocus(toISODate(new Date(t.year, t.month, day)));
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      onClose();
    }
  }

  const quick: { label: string; iso: string }[] = [
    { label: "Today", iso: today },
    { label: "Tomorrow", iso: toISODate(addDays(now, 1)) },
    { label: "Next week", iso: toISODate(addDays(now, 7)) },
  ];

  return (
    <div className={flag ? "cal flag" : "cal"} role="group" aria-label="Choose a date" onKeyDown={onKey}>
      <div className="cal-head">
        <button type="button" className="cal-nav" onClick={() => page(-1)} aria-label="Previous month">
          ‹
        </button>
        <span className="cal-title" aria-live="polite">
          {monthLabel(locale, view.year, view.month)}
        </span>
        <button type="button" className="cal-nav" onClick={() => page(1)} aria-label="Next month">
          ›
        </button>
      </div>
      <div className="cal-grid" role="grid" ref={gridRef}>
        {labels.map((l, i) => (
          <span key={`h${i}`} className="cal-dow" aria-hidden>
            {l}
          </span>
        ))}
        {cells.map((c) => {
          const disabled = !!min && c.iso < min;
          const cls = ["cal-day", c.inMonth ? "" : "out", c.iso === today ? "today" : "", c.iso === value ? "on" : "", c.iso === mark && c.iso !== value ? "mark" : ""]
            .filter(Boolean)
            .join(" ");
          return (
            <button
              key={c.iso}
              type="button"
              className={cls}
              data-iso={c.iso}
              disabled={disabled}
              tabIndex={c.iso === focus ? 0 : -1}
              aria-pressed={c.iso === value}
              aria-label={parseISODate(c.iso).toLocaleDateString(locale, {
                weekday: "long",
                month: "long",
                day: "numeric",
              })}
              onClick={() => pick(c.iso)}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  e.stopPropagation();
                  pick(c.iso);
                }
              }}
            >
              {c.day}
            </button>
          );
        })}
      </div>
      {!hideQuick && (
      <div className="cal-foot">
        {quick.map((q) => (
          <button key={q.label} type="button" className="cal-quick" onClick={() => pick(q.iso)}>
            {q.label}
          </button>
        ))}
        <button type="button" className="cal-quick clear" onClick={() => pick(null)}>
          No date
        </button>
      </div>
      )}
    </div>
  );
}
