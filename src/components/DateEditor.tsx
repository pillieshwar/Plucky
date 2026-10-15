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
export function DateEditor({ date, time, repeat, now, locale, onApply, onClose }: Props) {
  const [text, setText] = useState("");
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

  const quick = [
    { label: "Today", iso: today },
    { label: "Tomorrow", iso: toISODate(addDays(now, 1)) },
    { label: "Next week", iso: toISODate(addDays(now, 7)) },
  ];

  return (
    <div
      className="date-editor"
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.preventDefault();
          e.stopPropagation();
          onClose();
        }
      }}
    >
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
          <button
            key={q.label}
            type="button"
            className={date === q.iso ? "cal-quick on" : "cal-quick"}
            onClick={() => apply({ due_date: q.iso })}
          >
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
