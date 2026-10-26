import { useMemo } from "react";
import { timeLabel } from "../lib/schedule";

interface Props {
  value: string | null;
  /** `HH:MM`, or null for "no time". */
  onChange: (time: string | null) => void;
  locale: string;
  /** Show "In 1 hour" (only makes sense for today). */
  now?: Date;
}

const PRESETS = ["09:00", "12:00", "15:00", "18:00"];

const pad = (n: number) => String(n).padStart(2, "0");

/** Every half hour from 6:00 to 23:30, for "Other time". */
const SLOTS = Array.from({ length: 36 }, (_, i) => {
  const mins = 6 * 60 + i * 30;
  return `${pad(Math.floor(mins / 60))}:${pad(mins % 60)}`;
});

/** One hour from now, rounded up to the next quarter hour. */
export function inAnHour(now: Date): string {
  const d = new Date(now.getTime() + 60 * 60 * 1000);
  const q = Math.ceil(d.getMinutes() / 15) * 15;
  d.setMinutes(q, 0, 0);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * Pick a time in one tap: four common times, "In 1 hour", any half hour
 * from a list, or none — no typing.
 */
export function TimePicker({ value, onChange, locale, now }: Props) {
  const soon = now ? inAnHour(now) : null;
  const options = useMemo(() => {
    const all = new Set(SLOTS);
    if (value) all.add(value);
    return [...all].sort();
  }, [value]);
  const custom = value && !PRESETS.includes(value) && value !== soon;

  return (
    <div className="time-picker" role="group" aria-label="Time">
      <button
        type="button"
        className={value === null ? "tp-chip on" : "tp-chip"}
        aria-pressed={value === null}
        onClick={() => onChange(null)}
      >
        Any time
      </button>
      {PRESETS.map((t) => (
        <button
          key={t}
          type="button"
          className={value === t ? "tp-chip on" : "tp-chip"}
          aria-pressed={value === t}
          onClick={() => onChange(t)}
        >
          {timeLabel(t, locale).replace(":00", "")}
        </button>
      ))}
      {soon && (
        <button
          type="button"
          className={value === soon ? "tp-chip on" : "tp-chip"}
          aria-pressed={value === soon}
          onClick={() => onChange(soon)}
          title={timeLabel(soon, locale)}
        >
          In 1 hour
        </button>
      )}
      <label className={custom ? "tp-other on" : "tp-other"}>
        <span className="sr-only">Other time</span>
        <select value={custom ? value! : ""} onChange={(e) => e.target.value && onChange(e.target.value)}>
          <option value="">Other…</option>
          {options.map((t) => (
            <option key={t} value={t}>
              {timeLabel(t, locale)}
            </option>
          ))}
        </select>
      </label>
    </div>
  );
}
