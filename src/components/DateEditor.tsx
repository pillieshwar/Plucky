import { useEffect, useMemo, useRef, useState } from "react";
import { Calendar } from "./Calendar";
import { TimePicker } from "./TimePicker";
import { addDays, dayOrderForLocale, parseISODate, relativeLabel, toISODate } from "../lib/dates";
import { REPEATS, repeatLabel, resolveSchedule, timeLabel } from "../lib/schedule";
import type { TaskPatch } from "../lib/types";

export type DateTab = "when" | "deadline" | "repeat";

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
  /** Which part to open on. */
  tab?: DateTab;
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
 * Everything about *when*, in one small card with three tabs:
 *
 * - **Date & time** — type it ("fri 3pm", "every monday"), tap a quick day,
 *   or pick from a compact month; the time is a list you can also type into.
 * - **Deadline** — the same month and quick days, for the day it's due by.
 * - **Repeat** — one tap per rule.
 *
 * Changes apply as you make them; Done (or Esc) closes it.
 */
export function DateEditor({
  date,
  time,
  repeat,
  evening,
  someday,
  deadline,
  basic,
  tab: startTab = "when",
  paused,
  onSkip,
  onPause,
  now,
  locale,
  onApply: applyRaw,
  onClose,
}: Props) {
  const [tab, setTab] = useState<DateTab>(basic && startTab === "deadline" ? "when" : startTab);
  useEffect(() => setTab(basic && startTab === "deadline" ? "when" : startTab), [startTab, basic]);
  const [text, setText] = useState("");
  // Moving one day of a repeating task: just this one, or the whole series.
  const repeating = !!repeat && !basic;
  const [scope, setScope] = useState<"one" | "series">("one");
  const onApply = (patch: TaskPatch) =>
    applyRaw(repeating && patch.due_date !== undefined && !("recurrence" in patch) ? { ...patch, only_this: scope === "one" } : patch);
  const inputRef = useRef<HTMLInputElement>(null);
  const order = useMemo(() => dayOrderForLocale(locale), [locale]);
  const today = toISODate(now);
  const tomorrow = toISODate(addDays(now, 1));
  const nextWeek = toISODate(addDays(now, 7));

  useEffect(() => {
    if (tab === "when") inputRef.current?.focus();
  }, [tab]);

  const parsed = useMemo(() => (text.trim() ? resolveSchedule(text, now, order) : null), [text, now, order]);
  const understood = parsed && !parsed.leftover && (parsed.date || parsed.time || parsed.repeat);

  function applyTyped() {
    if (!parsed || !understood) return;
    const patch: TaskPatch = { due_date: parsed.date ?? date ?? today };
    if (parsed.time) patch.due_time = parsed.time;
    if (parsed.repeat) patch.recurrence = parsed.repeat;
    onApply(patch);
    setText("");
  }

  // This Friday (or next, when it's Friday or later).
  const friday = (() => {
    const d = new Date(now);
    const add = (5 - d.getDay() + 7) % 7 || 7;
    return toISODate(addDays(d, add));
  })();

  const dayQuick: { label: string; patch: TaskPatch; on: boolean }[] = [
    { label: "Today", patch: { due_date: today, evening: false }, on: date === today && !evening && !someday },
    { label: "This evening", patch: { due_date: today, evening: true }, on: date === today && !!evening },
    { label: "Tomorrow", patch: { due_date: tomorrow, evening: false }, on: date === tomorrow },
    { label: "Next week", patch: { due_date: nextWeek, evening: false }, on: date === nextWeek },
    { label: "Someday", patch: { someday: true }, on: !!someday },
  ].filter((q) => !basic || (q.label !== "This evening" && q.label !== "Someday"));

  const deadlineQuick: { label: string; iso: string }[] = [
    { label: "Today", iso: today },
    { label: "Tomorrow", iso: tomorrow },
    { label: "Friday", iso: friday },
    { label: "Next week", iso: nextWeek },
  ];

  const whenSummary = someday
    ? "Someday"
    : date
      ? [relativeLabel(date, now, locale), time && timeLabel(time, locale), evening && "evening"].filter(Boolean).join(", ")
      : "No date";
  const tabs: { id: DateTab; label: string; sub: string }[] = [
    { id: "when", label: "Date & time", sub: whenSummary },
    ...(!basic ? [{ id: "deadline" as DateTab, label: "Deadline", sub: deadline ? relativeLabel(deadline, now, locale) : "None" }] : []),
    { id: "repeat", label: "Repeat", sub: repeatLabel(repeat) ?? "Never" },
  ];

  return (
    <div
      className="date-editor"
      role="dialog"
      aria-label="When"
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.preventDefault();
          e.stopPropagation();
          onClose();
        }
      }}
    >
      <div className="de-tabs" role="tablist">
        {tabs.map((t) => (
          <button key={t.id} type="button" role="tab" aria-selected={tab === t.id} className={tab === t.id ? "de-tab on" : "de-tab"} onClick={() => setTab(t.id)}>
            <span>{t.label}</span>
            <small>{t.sub}</small>
          </button>
        ))}
      </div>

      {tab === "when" && (
        <div className="de-pane">
          {repeating && (
            <div className="de-series">
              <span>Move</span>
              <div className="view-switch" role="radiogroup" aria-label="Which to move">
                <button type="button" role="radio" aria-checked={scope === "one"} className={scope === "one" ? "on" : ""} onClick={() => setScope("one")}>
                  This one
                </button>
                <button type="button" role="radio" aria-checked={scope === "series"} className={scope === "series" ? "on" : ""} onClick={() => setScope("series")}>
                  All of them
                </button>
              </div>
            </div>
          )}
          <div className="de-type">
            <input
              ref={inputRef}
              value={text}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  e.stopPropagation();
                  applyTyped();
                }
              }}
              placeholder="Type it… “fri 3pm”, “tomorrow evening”, “every monday”"
              aria-label="Type a date"
              spellCheck={false}
            />
            {parsed && (
              <span className={understood ? "de-preview" : "de-preview miss"} aria-live="polite">
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
                  "Try “tomorrow 9am” or “oct 20”"
                )}
              </span>
            )}
          </div>

          <div className="de-quick">
            {dayQuick.map((q) => (
              <button key={q.label} type="button" className={q.on ? "cal-quick on" : "cal-quick"} onClick={() => onApply(q.patch)}>
                {q.label}
              </button>
            ))}
            {(date || someday) && (
              <button type="button" className="cal-quick clear" onClick={() => onApply({ due_date: null, someday: false })}>
                No date
              </button>
            )}
          </div>

          <div className="de-body">
            <Calendar
              value={someday ? null : date}
              mark={deadline ?? null}
              onChange={(iso) => onApply({ due_date: iso })}
              onClose={onClose}
              now={now}
              locale={locale}
              autoFocus={false}
              hideQuick
              stayOpen
            />
            <div className="de-side">
              <span className="de-label">Time</span>
              <TimePicker
                value={time}
                locale={locale}
                now={!date || date === today ? now : undefined}
                onChange={(t) => onApply({ due_date: date ?? today, due_time: t })}
              />
              {date && (
                <p className="de-note">
                  {parseISODate(date).toLocaleDateString(locale, { weekday: "long", month: "long", day: "numeric" })}
                  {time ? ` at ${timeLabel(time, locale)}` : ""}
                </p>
              )}
            </div>
          </div>
        </div>
      )}

      {tab === "deadline" && !basic && (
        <div className="de-pane">
          <p className="de-help">The day it must be done by. It shows in Today when that day comes, even if it's planned for later.</p>
          <div className="de-quick">
            {deadlineQuick.map((q) => (
              <button key={q.label} type="button" className={deadline === q.iso ? "cal-quick on" : "cal-quick"} onClick={() => onApply({ deadline: q.iso })}>
                {q.label}
              </button>
            ))}
            {date && (
              <button type="button" className={deadline === date ? "cal-quick on" : "cal-quick"} onClick={() => onApply({ deadline: date })}>
                Planned day
              </button>
            )}
            {deadline && (
              <button type="button" className="cal-quick clear" onClick={() => onApply({ deadline: null })}>
                No deadline
              </button>
            )}
          </div>
          <div className="de-body">
            <Calendar
              value={deadline ?? null}
              mark={date}
              onChange={(iso) => onApply({ deadline: iso })}
              onClose={onClose}
              now={now}
              locale={locale}
              autoFocus={false}
              hideQuick
              stayOpen
              flag
            />
          </div>
        </div>
      )}

      {tab === "repeat" && (
        <div className="de-pane">
          <div className="de-repeat" role="radiogroup" aria-label="Repeat">
            <button type="button" role="radio" aria-checked={!repeat} className={!repeat ? "cal-quick on" : "cal-quick"} onClick={() => onApply({ recurrence: null })}>
              Never
            </button>
            {REPEATS.map((r) => (
              <button
                key={r.id}
                type="button"
                role="radio"
                aria-checked={repeat === r.id}
                className={repeat === r.id ? "cal-quick on" : "cal-quick"}
                onClick={() => onApply({ due_date: date ?? today, recurrence: r.id })}
              >
                {r.label}
              </button>
            ))}
          </div>
          <p className="de-help">
            {repeat
              ? `${repeatLabel(repeat)}, from ${relativeLabel(date ?? today, now, locale)}${paused ? " · paused" : ""}. When you finish one, the next appears.`
              : "Pick a rule and the next one appears when you finish this one."}
          </p>
          {repeating && (
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
            </div>
          )}
        </div>
      )}

      <div className="de-foot">
        <span className="de-summary">
          {whenSummary}
          {!basic && deadline ? ` · due by ${relativeLabel(deadline, now, locale)}` : ""}
          {repeat ? ` · ${repeatLabel(repeat)?.toLowerCase()}` : ""}
        </span>
        <button type="button" className="de-done" onClick={onClose}>
          Done
        </button>
      </div>
    </div>
  );
}
