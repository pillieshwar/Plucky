import { useEffect, useMemo, useRef, useState } from "react";
import { Calendar } from "./Calendar";
import { addDays, dayOrderForLocale, relativeLabel, resolveExtraction, toISODate } from "../lib/dates";
import type { CaptureResult, Extraction, NewTask } from "../lib/types";
import { safeLocale } from "../lib/locale";

export type CaptureState =
  | { phase: "extracting"; selection: string }
  | { phase: "review"; selection: string; extraction: Extraction }
  | { phase: "manual"; selection: string; error: string }
  | { phase: "notice"; result: Exclude<CaptureResult, { kind: "text" }> };

interface Props {
  state: CaptureState;
  now: Date;
  onSave: (task: NewTask) => Promise<void>;
  onCancel: () => void;
  onGrantAccess: () => void;
}

const LOCALE = safeLocale();

export function CaptureCard({ state, now, onSave, onCancel, onGrantAccess }: Props) {
  if (state.phase === "notice")
    return <Notice result={state.result} onCancel={onCancel} onGrantAccess={onGrantAccess} />;
  if (state.phase === "extracting") {
    return (
      <section className="capture" aria-live="polite">
        <p className="capture-kicker">Captured locally</p>
        <p className="capture-source">{truncate(state.selection, 240)}</p>
        <div className="extracting">
          <span className="pulse" aria-hidden /> Reading it with the model on this computer…
        </div>
      </section>
    );
  }
  return <Review key={state.selection} state={state} now={now} onSave={onSave} onCancel={onCancel} />;
}

function Review({
  state,
  now,
  onSave,
  onCancel,
}: {
  state: Extract<CaptureState, { phase: "review" | "manual" }>;
  now: Date;
  onSave: Props["onSave"];
  onCancel: () => void;
}) {
  const resolution = useMemo(() => {
    if (state.phase === "manual") return { date: null, alternatives: [], confident: false, mustAsk: true };
    const { date_text, date_confidence } = state.extraction;
    return resolveExtraction(date_text, date_confidence, now, dayOrderForLocale(LOCALE));
  }, [state, now]);

  const [title, setTitle] = useState(state.phase === "review" ? state.extraction.task : firstLine(state.selection));
  const [date, setDate] = useState<string | null>(resolution.date);
  const [saving, setSaving] = useState(false);
  const [picking, setPicking] = useState(false);
  const titleRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    titleRef.current?.focus();
    titleRef.current?.select();
  }, []);

  const today = toISODate(now);
  const choices = dedupe([
    resolution.date,
    ...resolution.alternatives,
    today,
    toISODate(addDays(now, 1)),
    toISODate(addDays(now, 7)),
  ]);

  async function save() {
    if (!title.trim() || saving) return;
    setSaving(true);
    try {
      await onSave({ title: title.trim(), due_date: date, source_text: state.selection });
    } finally {
      setSaving(false);
    }
  }

  const dateText = state.phase === "review" ? state.extraction.date_text : null;
  const question = !dateText
    ? "No date in the text. When is this due?"
    : resolution.date && resolution.mustAsk
      ? `“${dateText}” could mean more than one day. Which one?`
      : resolution.date
        ? `Read “${dateText}” as ${relativeLabel(resolution.date, now, LOCALE).toLowerCase()}.`
        : `Couldn’t pin down “${dateText}”. Pick a day?`;

  return (
    <form
      className="capture"
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.stopPropagation();
          onCancel();
        }
      }}
    >
      <p className="capture-kicker">
        {state.phase === "manual" ? "Couldn’t extract a task — edit it yourself" : "New task"}
      </p>
      {state.phase === "manual" && <p className="capture-error">{state.error}</p>}
      <input
        ref={titleRef}
        className="capture-title"
        value={title}
        maxLength={200}
        onChange={(e) => setTitle(e.target.value)}
        aria-label="Task title"
      />
      <p className={resolution.mustAsk ? "capture-question ask" : "capture-question"}>{question}</p>
      <div className="chips" role="radiogroup" aria-label="Due date">
        {choices.map((d) => (
          <button
            type="button"
            key={d}
            role="radio"
            aria-checked={date === d}
            className={date === d ? "chip on" : "chip"}
            onClick={() => setDate(d)}
          >
            {relativeLabel(d, now, LOCALE)}
          </button>
        ))}
        <button
          type="button"
          role="radio"
          aria-checked={date === null}
          className={date === null ? "chip on" : "chip"}
          onClick={() => setDate(null)}
        >
          No date
        </button>
        {date && !choices.includes(date) && (
          <button type="button" role="radio" aria-checked className="chip on" onClick={() => setPicking(true)}>
            {relativeLabel(date, now, LOCALE)}
          </button>
        )}
        <button
          type="button"
          className={picking ? "chip chip-pick open" : "chip chip-pick"}
          aria-expanded={picking}
          onClick={() => setPicking((p) => !p)}
        >
          <CalendarIcon /> Pick a date
        </button>
      </div>
      {picking && (
        <Calendar
          value={date}
          onChange={setDate}
          onClose={() => setPicking(false)}
          now={now}
          locale={LOCALE}
          min={today}
        />
      )}
      <details className="capture-source-toggle">
        <summary>Selected text</summary>
        <p className="capture-source">{truncate(state.selection, 600)}</p>
      </details>
      <div className="capture-actions">
        <button type="button" className="ghost" onClick={onCancel}>
          Discard <kbd>Esc</kbd>
        </button>
        <button type="submit" className="primary" disabled={!title.trim() || saving}>
          Add task <kbd>↵</kbd>
        </button>
      </div>
    </form>
  );
}

function Notice({
  result,
  onCancel,
  onGrantAccess,
}: {
  result: Exclude<CaptureResult, { kind: "text" }>;
  onCancel: () => void;
  onGrantAccess: () => void;
}) {
  const copy = {
    nothing_selected: {
      title: "No selected text found",
      body: "Select some text in any app, then press the shortcut again. Password fields and some secure apps can’t be read.",
    },
    permission_needed: {
      title: "Pluck needs Accessibility access",
      body: "macOS only lets apps read selected text with your permission. Grant access in System Settings → Privacy & Security → Accessibility, then try again.",
    },
    clipboard_busy: {
      title: "Couldn’t read this selection safely",
      body: "Your clipboard holds something very large (like a big image) that Pluck can’t safely set aside. Copy the text yourself (⌘C), then press the shortcut again.",
    },
    failed: {
      title: "Couldn’t read the selection",
      body: `${result.kind === "failed" ? result.message : ""} If this keeps happening, use “Show log file” in Settings and send it along.`,
    },
  }[result.kind];
  return (
    <section className="capture notice" role="alert">
      <p className="capture-kicker">{copy.title}</p>
      <p className="capture-question">{copy.body}</p>
      <div className="capture-actions">
        <button type="button" className="ghost" onClick={onCancel}>
          Dismiss
        </button>
        {result.kind === "permission_needed" && (
          <button type="button" className="primary" onClick={onGrantAccess}>
            Grant access
          </button>
        )}
      </div>
    </section>
  );
}

function dedupe(xs: (string | null)[]): string[] {
  return [...new Set(xs.filter((x): x is string => !!x))];
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

function firstLine(s: string): string {
  return truncate(s.trim().split(/\n/)[0] ?? "", 200);
}

export function CalendarIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 16 16" aria-hidden fill="none" stroke="currentColor" strokeWidth="1.6">
      <rect x="2" y="3" width="12" height="11" rx="2" />
      <path d="M2 6.5h12M5.5 1.5v3M10.5 1.5v3" strokeLinecap="round" />
    </svg>
  );
}
