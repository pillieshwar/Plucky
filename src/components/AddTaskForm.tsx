import { useWords } from "../lib/words";
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
  projects,
  onAdd,
  onCancel,
  places,
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
  /** Existing project names, so "@off" files the task in "Offsite 2026". */
  projects?: string[];
  /**
   * Full screen: choose the building and floor, and the date and time,
   * right in the form. Floors are each building's headings.
   */
  places?: { name: string; floors: string[] }[];
  /** Save the task. */
  onAdd: (task: NewTask) => Promise<void>;
  onCancel: () => void;
}) {
  const w = useWords();
  const [title, setTitle] = useState("");
  const [notes, setNotes] = useState("");
  const [showNotes, setShowNotes] = useState(false);
  const [stepsText, setStepsText] = useState("");
  const [showSteps, setShowSteps] = useState(false);
  const [busy, setBusy] = useState(false);
  // Full screen's pickers (undefined: not touched, follow the typed text / the list).
  const [pickBuilding, setPickBuilding] = useState<string | null | undefined>(undefined);
  const [pickFloor, setPickFloor] = useState<string | null | undefined>(undefined);
  const [newBuilding, setNewBuilding] = useState<string | null>(null);
  const [newFloor, setNewFloor] = useState<string | null>(null);
  const [pickDate, setPickDate] = useState("");
  const [pickTime, setPickTime] = useState("");
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

  // "@Project" anywhere in the title files the task there.
  const at = useMemo(() => atProject(title, projects ?? []), [title, projects]);
  const typed = useMemo(() => (at.rest.trim() ? findSchedule(at.rest, now, order) : null), [at.rest, now, order]);

  async function submit(e?: FormEvent) {
    e?.preventDefault();
    const clean = (typed?.title || at.rest).trim();
    if (!clean || busy) return;
    setBusy(true);
    // Where it goes and when, from the pickers (full screen) over the typed text.
    const building = newBuilding?.trim() || (pickBuilding === undefined ? (at.project ?? extra?.project ?? null) : pickBuilding);
    const floor = building ? newFloor?.trim() || (pickFloor === undefined ? (extra?.heading ?? null) : pickFloor) : null;
    const placed = places ? { project: building, heading: floor } : {};
    const timed = places && pickDate ? { due_date: pickDate, due_time: pickTime || null, someday: false } : places && pickTime ? { due_time: pickTime } : {};
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
        ...(at.project ? { project: at.project, heading: null } : {}),
        ...placed,
        ...timed,
      });
      setPickDate("");
      setPickTime("");
      setNewBuilding(null);
      setNewFloor(null);
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
          placeholder={`${cap(w.steps)}, one per line\n- or paste a list`}
          rows={compact ? 2 : 3}
          maxLength={4000}
          aria-label={cap(w.steps)}
        />
      )}
      {places && (
        <PlacePicker
          places={places}
          building={newBuilding !== null ? "__new" : pickBuilding === undefined ? (at.project ?? extra?.project ?? null) : pickBuilding}
          floor={newFloor !== null ? "__new" : pickFloor === undefined ? (extra?.heading ?? null) : pickFloor}
          newBuilding={newBuilding}
          newFloor={newFloor}
          date={pickDate}
          time={pickTime}
          onBuilding={(b) => {
            if (b === "__new") {
              setNewBuilding("");
              return;
            }
            setNewBuilding(null);
            setPickBuilding(b);
            setPickFloor(null);
            setNewFloor(null);
          }}
          onFloor={(f) => {
            if (f === "__new") {
              setNewFloor("");
              return;
            }
            setNewFloor(null);
            setPickFloor(f);
          }}
          onNewBuilding={setNewBuilding}
          onNewFloor={setNewFloor}
          onDate={setPickDate}
          onTime={setPickTime}
        />
      )}
      <div className="add-task-foot">
        <span className={typed?.date ? "add-task-when on" : "add-task-when"}>
          {when}
          {at.project ? (
            <span className="add-task-context"> · {w.inProject(at.project)}</span>
          ) : (
            context && <span className="add-task-context"> · {context}</span>
          )}
        </span>
        {!showNotes && (
          <button type="button" className="add-task-link" onClick={() => setShowNotes(true)}>
            + Description
          </button>
        )}
        {!showSteps && (
          <button type="button" className="add-task-link" onClick={() => setShowSteps(true)}>
            + {cap(w.steps)}
          </button>
        )}
        <button type="button" className="add-task-link quiet" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/**
 * Pull "@Name" out of a title: the existing project it starts (case
 * insensitive), or a new one by that name. Words after "@" up to the next
 * "@", "#" or the end of a known name are taken; unknown names take one word.
 */
export function atProject(title: string, projects: string[]): { project: string | null; rest: string } {
  const m = /(^|\s)@(\S[^@#]*)/.exec(title);
  if (!m) return { project: null, rest: title };
  const after = m[2];
  const lower = after.toLowerCase();
  // The longest existing project the text starts with, or one starting with the first word.
  const exact = [...projects]
    .sort((a, b) => b.length - a.length)
    .find((p) => lower.startsWith(p.toLowerCase()) && /^(\s|$)/.test(after.slice(p.length)));
  const word = after.split(/\s+/)[0];
  const prefix = exact ?? projects.find((p) => p.toLowerCase().startsWith(word.toLowerCase())) ?? null;
  const used = exact ?? word;
  const project = exact ?? prefix ?? word;
  const start = m.index + m[1].length;
  const rest = (title.slice(0, start) + title.slice(start + 1 + used.length)).replace(/\s+/g, " ").trim();
  return { project: project.trim() || null, rest };
}

/** Building, floor, date and time pickers for a new room (full screen). */
function PlacePicker(p: {
  places: { name: string; floors: string[] }[];
  building: string | null;
  floor: string | null;
  newBuilding: string | null;
  newFloor: string | null;
  date: string;
  time: string;
  onBuilding: (b: string | null) => void;
  onFloor: (f: string | null) => void;
  onNewBuilding: (n: string) => void;
  onNewFloor: (n: string) => void;
  onDate: (d: string) => void;
  onTime: (t: string) => void;
}) {
  const floors = p.places.find((x) => x.name === p.building)?.floors ?? [];
  const known = p.building === null || p.building === "__new" || p.places.some((x) => x.name === p.building);
  return (
    <div className="add-place">
      <label className="ap-field">
        <span>Building</span>
        {p.newBuilding !== null ? (
          <input autoFocus value={p.newBuilding} maxLength={60} placeholder="New building's name" onChange={(e) => p.onNewBuilding(e.target.value)} />
        ) : (
          <select value={p.building ?? ""} onChange={(e) => p.onBuilding(e.target.value || null)}>
            <option value="">Main Street (no building)</option>
            {!known && p.building && <option value={p.building}>{p.building} (new)</option>}
            {p.places.map((x) => (
              <option key={x.name} value={x.name}>
                {x.name}
              </option>
            ))}
            <option value="__new">+ New building…</option>
          </select>
        )}
      </label>
      <label className="ap-field">
        <span>Floor</span>
        {p.newFloor !== null ? (
          <input autoFocus value={p.newFloor} maxLength={60} placeholder="New floor's name" onChange={(e) => p.onNewFloor(e.target.value)} />
        ) : (
          <select value={p.floor ?? ""} disabled={!p.building} onChange={(e) => p.onFloor(e.target.value || null)}>
            <option value="">Lobby (choose a floor later)</option>
            {floors.map((f) => (
              <option key={f} value={f}>
                {f}
              </option>
            ))}
            {p.building && <option value="__new">+ New floor…</option>}
          </select>
        )}
      </label>
      <label className="ap-field">
        <span>Date</span>
        <input type="date" value={p.date} onChange={(e) => p.onDate(e.target.value)} />
      </label>
      <label className="ap-field">
        <span>Time</span>
        <input type="time" value={p.time} onChange={(e) => p.onTime(e.target.value)} />
      </label>
    </div>
  );
}
