import { useEffect, useMemo, useRef, useState } from "react";
import { DateEditor } from "./DateEditor";
import { CalendarIcon, ClockIcon, RepeatIcon } from "./icons";
import { addDays, dayOrderForLocale, relativeLabel, toISODate } from "../lib/dates";
import { repeatLabel, resolveCaptured, timeLabel } from "../lib/schedule";
import { sourceLabel } from "../lib/taskText";
import type { CaptureResult, Extraction, NewTask, SourceInfo, TaskPatch } from "../lib/types";
import { safeLocale } from "../lib/locale";

export type CaptureState =
  | { phase: "extracting"; selection: string; source: SourceInfo | null }
  | { phase: "review"; selection: string; source: SourceInfo | null; extraction: Extraction }
  | { phase: "manual"; selection: string; source: SourceInfo | null; error: string }
  | { phase: "notice"; result: Exclude<CaptureResult, { kind: "text" }> };

interface Props {
  state: CaptureState;
  now: Date;
  onSave: (task: NewTask) => Promise<void>;
  onCancel: () => void;
  onGrantAccess: () => void;
}

const LOCALE = safeLocale();

/** The task being reviewed before it's saved. */
interface Draft {
  title: string;
  date: string | null;
  time: string | null;
  repeat: string | null;
  /** The model's date phrase, for the question line. */
  dateText: string | null;
  alternatives: string[];
  mustAsk: boolean;
}

function draftFor(state: Extract<CaptureState, { phase: "review" | "manual" }>, now: Date): Draft {
  if (state.phase === "manual") {
    return {
      title: firstLine(state.selection),
      date: null,
      time: null,
      repeat: null,
      dateText: null,
      alternatives: [],
      mustAsk: true,
    };
  }
  const x = state.extraction;
  const r = resolveCaptured(x.date_text, x.date_confidence, now, dayOrderForLocale(LOCALE));
  return {
    title: x.task,
    date: r.date,
    time: r.time,
    repeat: r.repeat,
    dateText: x.date_text,
    alternatives: r.alternatives,
    mustAsk: r.mustAsk,
  };
}

export function CaptureCard({ state, now, onSave, onCancel, onGrantAccess }: Props) {
  if (state.phase === "notice")
    return <Notice result={state.result} onCancel={onCancel} onGrantAccess={onGrantAccess} />;
  if (state.phase === "extracting") {
    return (
      <section className="capture" aria-live="polite" aria-busy="true">
        <Kicker source={state.source} text="Reading it on this Mac…" />
        <div className="skeleton title" />
        <div className="skeleton-row">
          <div className="skeleton chip" />
          <div className="skeleton chip" />
          <div className="skeleton chip short" />
        </div>
        <p className="capture-source faded">{truncate(state.selection, 240)}</p>
      </section>
    );
  }
  return <Review key={state.selection} state={state} now={now} onSave={onSave} onCancel={onCancel} />;
}

function Kicker({ source, text }: { source: SourceInfo | null; text: string }) {
  const from = source ? sourceLabel({ source_app: source.app, source_url: source.url }) : null;
  return (
    <p className="capture-kicker">
      {from ? (
        <>
          From <strong>{from}</strong> · {text}
        </>
      ) : (
        text
      )}
    </p>
  );
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
  const [draft, setDraft] = useState<Draft>(() => draftFor(state, now));
  const [saving, setSaving] = useState(false);
  const ready = !!draft.title.trim();

  async function save() {
    if (!ready || saving) return;
    setSaving(true);
    try {
      await onSave({
        title: draft.title.trim(),
        due_date: draft.date,
        due_time: draft.date ? draft.time : null,
        recurrence: draft.repeat,
        source_text: state.selection,
        source_app: state.source?.app ?? null,
        source_bundle: state.source?.bundle ?? null,
        source_url: state.source?.url ?? null,
      });
    } finally {
      setSaving(false);
    }
  }

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
      <Kicker
        source={state.source}
        text={state.phase === "manual" ? "Couldn’t read it — edit it yourself" : "New task"}
      />
      {state.phase === "manual" && <p className="capture-error">{state.error}</p>}

      <Single draft={draft} now={now} onChange={(p) => setDraft((d) => ({ ...d, ...p }))} />

      <details className="capture-source-toggle">
        <summary>Selected text</summary>
        <p className="capture-source">{truncate(state.selection, 600)}</p>
      </details>
      <div className="capture-actions">
        <button type="button" className="ghost" onClick={onCancel}>
          Discard <kbd>Esc</kbd>
        </button>
        <button type="submit" className="primary" disabled={!ready || saving}>
          Add task <kbd>↵</kbd>
        </button>
      </div>
    </form>
  );
}

function whenLabel(d: Pick<Draft, "date" | "time" | "repeat">, now: Date): string {
  if (!d.date) return "No date";
  return [
    relativeLabel(d.date, now, LOCALE),
    d.time && timeLabel(d.time, LOCALE),
    d.repeat && repeatLabel(d.repeat)?.toLowerCase(),
  ]
    .filter(Boolean)
    .join(" · ");
}

function applyPatch(d: Draft, p: TaskPatch): Partial<Draft> {
  const next: Partial<Draft> = { mustAsk: false };
  if (p.due_date !== undefined) next.date = p.due_date;
  if (p.due_time !== undefined) next.time = p.due_time;
  if (p.recurrence !== undefined) next.repeat = p.recurrence;
  if (p.due_date === null) {
    next.time = null;
    next.repeat = null;
  }
  return { ...next, date: next.date === undefined ? d.date : next.date };
}

function Single({ draft, now, onChange }: { draft: Draft; now: Date; onChange: (p: Partial<Draft>) => void }) {
  const [picking, setPicking] = useState(false);
  const titleRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    titleRef.current?.focus();
    titleRef.current?.select();
  }, []);

  const today = toISODate(now);
  const choices = useMemo(
    () =>
      dedupe([
        draft.dateText ? draft.date : null,
        ...draft.alternatives,
        today,
        toISODate(addDays(now, 1)),
        toISODate(addDays(now, 7)),
      ]),
    // Keep the chip order stable while the user clicks around.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  const question = !draft.dateText
    ? "No date in the text. When is this due?"
    : draft.mustAsk && draft.date
      ? `“${draft.dateText}” could mean more than one day. Which one?`
      : draft.date
        ? `Read “${draft.dateText}” as ${whenLabel(draft, now)}.`
        : `Couldn’t pin down “${draft.dateText}”. Pick a day?`;

  return (
    <>
      <input
        ref={titleRef}
        className="capture-title"
        value={draft.title}
        maxLength={200}
        onChange={(e) => onChange({ title: e.target.value })}
        aria-label="Task title"
      />
      <p className={draft.mustAsk ? "capture-question ask" : "capture-question"}>{question}</p>
      <div className="chips" role="radiogroup" aria-label="Due date">
        {choices.map((d) => (
          <button
            type="button"
            key={d}
            role="radio"
            aria-checked={draft.date === d}
            className={draft.date === d ? "chip on" : "chip"}
            onClick={() => onChange({ date: d, mustAsk: false })}
          >
            {relativeLabel(d, now, LOCALE)}
          </button>
        ))}
        <button
          type="button"
          role="radio"
          aria-checked={draft.date === null}
          className={draft.date === null ? "chip on" : "chip"}
          onClick={() => onChange({ date: null, time: null, repeat: null, mustAsk: false })}
        >
          No date
        </button>
        {draft.date && !choices.includes(draft.date) && (
          <button type="button" role="radio" aria-checked className="chip on" onClick={() => setPicking(true)}>
            {relativeLabel(draft.date, now, LOCALE)}
          </button>
        )}
        <button
          type="button"
          className={picking ? "chip chip-pick open" : "chip chip-pick"}
          aria-expanded={picking}
          onClick={() => setPicking((p) => !p)}
        >
          <CalendarIcon /> More…
        </button>
      </div>
      {(draft.time || draft.repeat) && draft.date && (
        <p className="capture-extras">
          {draft.time && (
            <span className="extra">
              <ClockIcon /> {timeLabel(draft.time, LOCALE)}
              <button type="button" aria-label="Remove time" onClick={() => onChange({ time: null })}>
                ×
              </button>
            </span>
          )}
          {draft.repeat && (
            <span className="extra">
              <RepeatIcon /> {repeatLabel(draft.repeat)}
              <button type="button" aria-label="Don't repeat" onClick={() => onChange({ repeat: null })}>
                ×
              </button>
            </span>
          )}
        </p>
      )}
      {picking && (
        <DateEditor
          date={draft.date}
          time={draft.time}
          repeat={draft.repeat}
          now={now}
          locale={LOCALE}
          onApply={(p) => onChange(applyPatch(draft, p))}
          onClose={() => setPicking(false)}
        />
      )}
    </>
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
      body: "Select some text in any app, then press the shortcut again. Password fields and some secure apps can’t be read. Tip: you can also right-click selected text → Services → Add to Pluck.",
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
