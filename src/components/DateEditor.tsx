import { useEffect, useMemo, useRef, useState } from "react";
import { Calendar } from "./Calendar";
import { TimePicker } from "./TimePicker";
import { addDays, dayOrderForLocale, relativeLabel, toISODate } from "../lib/dates";
import { REPEATS, repeatLabel, resolveSchedule, timeLabel } from "../lib/schedule";
import type { TaskPatch } from "../lib/types";

interface Props {
  date: string | null;
  time: string | null;
  repeat: string | null;
  /** Planned for this evening / parked in Someday / hard deadline. */
  evening?: boolean;
  someday?: boolean;
  deadline?: string | null;
  /** Only day, time and repeat (for a task not saved yet). */
  basic?: boolean;
  /** For a saved repeating task: skip this one, pause/resume. */
  paused?: boolean;
  onSkip?: () => void;
  onPause?: (paused: boolean) => void;
  now: Date;
  locale: string;
  onApply: (patch: TaskPatch) => void;
  onClose: () => void;
}

/**
 * Everything about *when*: type it in plain words ("fri 3pm", "every
 * monday"), tap a quick day, pick from the calendar, or set a time and a
 * repeat. Renders inline, so it can't be cut off.
 */
export function DateEditor({
  date,
  time,
  repeat,
  evening,
  someday,
  deadline,
  basic,
  paused,
  onSkip,
  onPause,
  now,
  locale,
  onApply: applyRaw,
  onClose,
}: Props) {
  const [text, setText] = useState("");
  // Moving one day of a repeating task: just this one, or the whole series.
  const repeating = !!repeat && !basic;
  const [scope, setScope] = useState<"one" | "series">("one");
  const onApply = (patch: TaskPatch) =>
    applyRaw(repeating && patch.due_date !== undefined && !("recurrence" in patch) ? { ...patch, only_this: scope === "one" } : patch);
  const inputRef = useRef<HTMLInputElement>(null);
  const order = useMemo(() => dayOrderForLocale(locale), [locale]);
  const today = toISODate(now);

  useEffect(() => inputRef.current?.focus(), []);

  const parsed = useMemo(() => (text.trim() ? resolveSchedule(text, now, order) : null), [text, now, order]);
  const understood = parsed && !parsed.leftover && (parsed.date || parsed.time || parsed.repeat);

  function apply(patch: TaskPatch, close = true) {
    onApply(patch);
    if (close) onClose();
  }

  function applyTyped() {
    if (!parsed || !understood) return;
    const patch: TaskPatch = { due_date: parsed.date ?? date ?? today };
    if (parsed.time) patch.due_time = parsed.time;
    if (parsed.repeat) patch.recurrence = parsed.repeat;
    apply(patch);
  }

  const quick: { label: string; patch: TaskPatch; on: boolean }[] = [
    { label: "Today", patch: { due_date: today, evening: false }, on: date === today && !evening },
    { label: "This evening", patch: { due_date: today, evening: true }, on: date === today && !!evening },
    { label: "Tomorrow", patch: { due_date: toISODate(addDays(now, 1)) }, on: date === toISODate(addDays(now, 1)) },
    { label: "Next week", patch: { due_date: toISODate(addDays(now, 7)) }, on: date === toISODate(addDays(now, 7)) },
    { label: "Someday", patch: { someday: true }, on: !!someday },
  ].filter((q) => !basic || (q.label !== "This evening" && q.label !== "Someday"));

  return (
    <div
      className={repeating ? "date-editor repeating" : "date-editor"}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.preventDefault();
          e.stopPropagation();
          onClose();
        }
      }}
    >
      {repeating && (
        <div className="de-series">
          <span className="de-series-label">
            {paused ? "Paused · repeats " : "Repeats "}
            {(REPEATS.find((r) => r.id === repeat)?.label ?? repeat)?.toLowerCase()}. Change
          </span>
          <div className="view-switch" role="radiogroup" aria-label="Which to change">
            <button type="button" role="radio" aria-checked={scope === "one"} className={scope === "one" ? "on" : ""} onClick={() => setScope("one")}>
              This one
            </button>
            <button type="button" role="radio" aria-checked={scope === "series"} className={scope === "series" ? "on" : ""} onClick={() => setScope("series")}>
              All
            </button>
          </div>
          <div className="de-series-actions">
            {onSkip && (
              <button type="button" className="de-link" onClick={() => { onSkip(); onClose(); }} title="Move this one to the series' next day">
                Skip this one
              </button>
            )}
            {onPause && (
              <button type="button" className="de-link" onClick={() => { onPause(!paused); onClose(); }}>
                {paused ? "Resume" : "Pause"}
              </button>
            )}
            <button type="button" className="de-link danger" onClick={() => apply({ recurrence: null })} title="Keep this task, stop making new ones">
              Stop repeating
            </button>
          </div>
        </div>
      )}
      <form
        className="de-type"
        onSubmit={(e) => {
          e.preventDefault();
          applyTyped();
        }}
      >
        <input
          ref={inputRef}
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Type a date… “fri 3pm”, “every monday”"
          aria-label="Type a date"
          spellCheck={false}
        />
      </form>
      {parsed && (
        <p className={understood ? "de-preview" : "de-preview miss"} aria-live="polite">
          {understood ? (
            <>
              {[
                parsed.date && relativeLabel(parsed.date, now, locale),
                parsed.time && timeLabel(parsed.time, locale),
                parsed.repeat && repeatLabel(parsed.repeat)?.toLowerCase(),
              ]
                .filter(Boolean)
                .join(" · ")}
              <kbd>↵</kbd>
            </>
          ) : (
            "Not sure what day that is — try “tomorrow 9am” or “oct 20”"
          )}
        </p>
      )}

      <div className="de-quick">
        {quick.map((q) => (
          <button key={q.label} type="button" className={q.on ? "cal-quick on" : "cal-quick"} onClick={() => apply(q.patch)}>
            {q.label}
          </button>
        ))}
        <button type="button" className="cal-quick clear" onClick={() => apply({ due_date: null })}>
          No date
        </button>
      </div>

      <TimePicker
        value={time}
        locale={locale}
        now={!date || date === today ? now : undefined}
        onChange={(t) => apply({ due_date: date ?? today, due_time: t }, false)}
      />

      {!basic && (
      <div className="de-row">
        <label className="de-field" title="The day it must be done by. It shows up in Today when the day comes, even if it's planned later.">
          <span>Deadline</span>
          <input
            type="date"
            value={deadline ?? ""}
            onChange={(e) => apply({ deadline: e.target.value || null }, false)}
            aria-label="Deadline"
          />
          {deadline && (
            <button type="button" className="de-clear" onClick={() => apply({ deadline: null }, false)} aria-label="Remove deadline">
              ×
            </button>
          )}
        </label>
      </div>
      )}

      <div className="de-row">
        <label className="de-field">
          <span>Repeat</span>
          <select
            value={repeat ?? ""}
            onChange={(e) => apply({ due_date: date ?? today, recurrence: e.target.value || null }, false)}
          >
            <option value="">Never</option>
            {REPEATS.map((r) => (
              <option key={r.id} value={r.id}>
                {r.label}
              </option>
            ))}
          </select>
        </label>
      </div>

      <Calendar
        value={date}
        onChange={(iso) => onApply({ due_date: iso })}
        onClose={onClose}
        now={now}
        locale={locale}
        autoFocus={false}
        hideQuick
      />
    </div>
  );
}
