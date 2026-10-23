import { useEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { dayOrderForLocale, relativeLabel } from "../lib/dates";
import { findSchedule, repeatLabel, timeLabel } from "../lib/schedule";
import { isDeadlinePhrase, linesToSteps } from "../lib/lists";
import type { NewTask } from "../lib/types";

/**
 * Add a task: a title (dates typed in it are understood — "dentist fri
 * 3pm") and an optional description. Used in the panel and the menu-bar
 * dropdown. Return in the title adds; ⌘Return adds from the description;
 * Esc cancels.
 */
export function AddTaskForm({
  locale,
  defaultDay,
  placeholder,
  compact,
  extra,
  context,
  onAdd,
  onCancel,
}: {
  locale: string;
  /** Day used when the title has no date (null: no date). */
  defaultDay: string | null;
  placeholder: string;
  /** Smaller, for the dropdown. */
  compact?: boolean;
  /** Set on every task added here (e.g. the project being viewed). */
  extra?: Partial<NewTask>;
  /** Where it goes, shown under the field ("In Offsite · Travel"). */
  context?: string;
  /** Save the task. */
  onAdd: (task: NewTask) => Promise<void>;
  onCancel: () => void;
}) {
  const [title, setTitle] = useState("");
  const [notes, setNotes] = useState("");
  const [showNotes, setShowNotes] = useState(false);
  const [stepsText, setStepsText] = useState("");
  const [showSteps, setShowSteps] = useState(false);
  const [busy, setBusy] = useState(false);
  const titleRef = useRef<HTMLInputElement>(null);
  const notesRef = useRef<HTMLTextAreaElement>(null);
  const now = useMemo(() => new Date(), []);
  const order = useMemo(() => dayOrderForLocale(locale), [locale]);

  useEffect(() => {
    titleRef.current?.focus();
  }, []);
  useEffect(() => {
    if (showNotes) notesRef.current?.focus();
  }, [showNotes]);

  const typed = useMemo(() => (title.trim() ? findSchedule(title, now, order) : null), [title, now, order]);

  async function submit(e?: FormEvent) {
    e?.preventDefault();
    const clean = (typed?.title || title).trim();
    if (!clean || busy) return;
    setBusy(true);
    try {
      await onAdd({
        due_date: typed?.date ?? defaultDay,
        ...extra,
        title: clean,
        ...(typed?.date ? { due_date: typed.date, due_time: typed.time, someday: false } : {}),
        // "by Friday": Friday is the deadline too.
        deadline: typed?.date && isDeadlinePhrase(typed.matched) ? typed.date : (extra?.deadline ?? null),
        recurrence: typed?.repeat ?? null,
        source_text: null,
        notes: notes.trim() || null,
        checklist: linesToSteps(stepsText).map((text) => ({ text, done: false })),
      });
      setTitle("");
      setNotes("");
      setShowNotes(false);
      setStepsText("");
      setShowSteps(false);
      titleRef.current?.focus();
    } catch {
      // The caller showed the error; keep what was typed.
    } finally {
      setBusy(false);
    }
  }

  function onKey(e: KeyboardEvent) {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      onCancel();
    } else if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      void submit();
    }
  }

  const when = typed?.date
    ? [
        relativeLabel(typed.date, now, locale),
        typed.time && timeLabel(typed.time, locale),
        typed.repeat && repeatLabel(typed.repeat)?.toLowerCase(),
        isDeadlinePhrase(typed.matched) && "deadline",
      ]
        .filter(Boolean)
        .join(" · ")
    : defaultDay
      ? relativeLabel(defaultDay, now, locale)
      : extra?.someday
        ? "Someday"
        : "No date — type one, like “fri 3pm”";

  return (
    <form className={compact ? "add-task compact" : "add-task"} onSubmit={(e) => void submit(e)} onKeyDown={onKey}>
      <div className="add-task-row">
        <input
          ref={titleRef}
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder={placeholder}
          maxLength={200}
          aria-label="Task"
        />
        <button type="submit" className="add-task-go" disabled={!title.trim() || busy}>
          Add
        </button>
      </div>
      {showNotes ? (
        <textarea
          ref={notesRef}
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          placeholder="Description, links… (⌘↩ to add)"
          rows={compact ? 2 : 3}
          maxLength={2000}
          aria-label="Description"
        />
      ) : null}
      {showSteps && (
        <textarea
          value={stepsText}
          autoFocus
          onChange={(e) => setStepsText(e.target.value)}
          placeholder={"Steps, one per line\n- or paste a list"}
          rows={compact ? 2 : 3}
          maxLength={4000}
          aria-label="Checklist steps"
        />
      )}
      <div className="add-task-foot">
        <span className={typed?.date ? "add-task-when on" : "add-task-when"}>
          {when}
          {context && <span className="add-task-context"> · {context}</span>}
        </span>
        {!showNotes && (
          <button type="button" className="add-task-link" onClick={() => setShowNotes(true)}>
            + Description
          </button>
        )}
        {!showSteps && (
          <button type="button" className="add-task-link" onClick={() => setShowSteps(true)}>
            + Steps
          </button>
        )}
        <button type="button" className="add-task-link quiet" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}
