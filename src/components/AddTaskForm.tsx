import { useWords } from "../lib/words";
import { useEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { dayOrderForLocale, relativeLabel } from "../lib/dates";
import { findSchedule, repeatLabel, timeLabel } from "../lib/schedule";
import { isDeadlinePhrase } from "../lib/lists";
import { Checklist } from "./Checklist";
import { DateEditor, type DateTab } from "./DateEditor";
import { CalendarIcon, RepeatIcon } from "./icons";
import { FlagIcon } from "./ProjectPicker";
import type { ChecklistItem, NewTask, TaskPatch } from "../lib/types";

/**
 * Add a task: a title (dates typed in it are understood — "dentist fri
 * 3pm"), notes and sub-tasks, and pills for when, deadline and repeat that
 * open the same small date card used everywhere. Return in the title adds;
 * ⌘Return adds from anywhere; Esc closes a picker, then cancels.
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
  roomy: roomyProp,
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
   * Full screen: choose the building and floor right in the form. Floors
   * are each building's headings.
   */
  places?: { name: string; floors: string[] }[];
  /** Full screen: notes and sub-tasks open from the start (default: when `places` is given). */
  roomy?: boolean;
  /** Save the task. */
  onAdd: (task: NewTask) => Promise<void>;
  onCancel: () => void;
}) {
  const w = useWords();
  const roomy = roomyProp ?? !!places;
  const [title, setTitle] = useState("");
  const [notes, setNotes] = useState("");
  const [showNotes, setShowNotes] = useState(roomy);
  const [steps, setSteps] = useState<ChecklistItem[]>([]);
  const [showSteps, setShowSteps] = useState(roomy);
  const [busy, setBusy] = useState(false);
  // Full screen's pickers (undefined: not touched, follow the typed text / the list).
  const [pickBuilding, setPickBuilding] = useState<string | null | undefined>(undefined);
  const [pickFloor, setPickFloor] = useState<string | null | undefined>(undefined);
  const [newBuilding, setNewBuilding] = useState<string | null>(null);
  const [newFloor, setNewFloor] = useState<string | null>(null);
  // When, picked by hand (null: follow what's typed in the title).
  const [picked, setPicked] = useState<When | null>(null);
  const [dateTab, setDateTab] = useState<DateTab | null>(null);
  const titleRef = useRef<HTMLInputElement>(null);
  const notesRef = useRef<HTMLTextAreaElement>(null);
  const now = useMemo(() => new Date(), []);
  const order = useMemo(() => dayOrderForLocale(locale), [locale]);

  useEffect(() => {
    titleRef.current?.focus();
  }, []);
  useEffect(() => {
    if (showNotes && !roomy) notesRef.current?.focus();
  }, [showNotes, roomy]);
  // Grow the notes box with its text.
  useEffect(() => {
    const el = notesRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 220)}px`;
  }, [notes, showNotes]);

  // "@Project" anywhere in the title files the task there.
  const at = useMemo(() => atProject(title, projects ?? []), [title, projects]);
  const typed = useMemo(() => (at.rest.trim() ? findSchedule(at.rest, now, order) : null), [at.rest, now, order]);

  // What the task will get: picked by hand, else typed, else the list's day.
  const fromTyped: When = {
    date: typed?.date ?? (extra?.someday ? null : (extra?.due_date ?? defaultDay)),
    time: typed?.date ? typed.time : null,
    repeat: typed?.repeat ?? null,
    deadline: typed?.date && isDeadlinePhrase(typed.matched) ? typed.date : (extra?.deadline ?? null),
    someday: !typed?.date && !!extra?.someday,
    evening: false,
  };
  const when = picked ?? fromTyped;

  function applyWhen(patch: TaskPatch) {
    setPicked((cur) => {
      const w0 = { ...(cur ?? fromTyped) };
      if (patch.someday) Object.assign(w0, { someday: true, date: null, time: null, evening: false });
      if (patch.due_date !== undefined) {
        Object.assign(w0, { date: patch.due_date, someday: false });
        if (patch.due_date === null) Object.assign(w0, { time: null, evening: false, repeat: null });
      }
      if (patch.someday === false) w0.someday = false;
      if (patch.due_time !== undefined) w0.time = patch.due_time;
      if (patch.evening !== undefined) w0.evening = patch.evening;
      if (patch.recurrence !== undefined) w0.repeat = patch.recurrence;
      if (patch.deadline !== undefined) w0.deadline = patch.deadline;
      return w0;
    });
  }

  async function submit(e?: FormEvent) {
    e?.preventDefault();
    const clean = (typed?.title || at.rest).trim();
    if (!clean || busy) return;
    setBusy(true);
    // Where it goes, from the pickers (full screen) over the typed text.
    const building = newBuilding?.trim() || (pickBuilding === undefined ? (at.project ?? extra?.project ?? null) : pickBuilding);
    const floor = building ? newFloor?.trim() || (pickFloor === undefined ? (extra?.heading ?? null) : pickFloor) : null;
    const placed = places ? { project: building, heading: floor } : {};
    try {
      await onAdd({
        ...extra,
        title: clean,
        due_date: when.someday ? null : when.date,
        due_time: when.date ? when.time : null,
        evening: !!when.date && when.evening,
        someday: when.someday,
        deadline: when.deadline,
        recurrence: when.date || !when.someday ? when.repeat : null,
        source_text: null,
        notes: notes.trim() || null,
        checklist: steps.filter((s) => s.text.trim()),
        ...(at.project ? { project: at.project, heading: null } : {}),
        ...placed,
      });
      setNewBuilding(null);
      setNewFloor(null);
      setPicked(null);
      setDateTab(null);
      setTitle("");
      setNotes("");
      setShowNotes(roomy);
      setSteps([]);
      setShowSteps(roomy);
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
      if (dateTab) setDateTab(null);
      else onCancel();
    } else if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      void submit();
    }
  }

  const whenText = when.someday
    ? "Someday"
    : when.date
      ? [relativeLabel(when.date, now, locale), when.time && timeLabel(when.time, locale), when.evening && "evening"].filter(Boolean).join(", ")
      : "No date";
  const toggleTab = (t: DateTab) => setDateTab((cur) => (cur === t ? null : t));
  const where = at.project ? w.inProject(at.project) : context;

  return (
    <form className={[compact ? "add-task compact" : "add-task", roomy ? "roomy" : ""].filter(Boolean).join(" ")} onSubmit={(e) => void submit(e)} onKeyDown={onKey}>
      <div className="add-task-row">
        <input
          ref={titleRef}
          className="add-task-title"
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
      {typed?.date && !picked && (
        <p className="add-task-understood">
          <CalendarIcon /> {whenText}
          {typed.repeat && ` · ${repeatLabel(typed.repeat)?.toLowerCase()}`}
          {isDeadlinePhrase(typed.matched) && " · deadline"}
          <span> — from “{typed.matched}”</span>
        </p>
      )}
      {showNotes && (
        <textarea
          ref={notesRef}
          className="add-task-notes"
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          placeholder="Notes — details, links… (⌘↩ adds the task)"
          rows={1}
          maxLength={2000}
          aria-label="Notes"
        />
      )}
      {showSteps && (
        <div className="add-task-steps">
          <Checklist items={steps} onChange={setSteps} autoFocusAdd={!roomy} />
        </div>
      )}

      <div className="add-task-pills">
        <button type="button" className={pillClass(dateTab === "when", !!when.date || when.someday)} onClick={() => toggleTab("when")}>
          <CalendarIcon /> {whenText}
        </button>
        <button type="button" className={pillClass(dateTab === "deadline", !!when.deadline)} onClick={() => toggleTab("deadline")}>
          <FlagIcon /> {when.deadline ? `Due ${relativeLabel(when.deadline, now, locale)}` : "Deadline"}
        </button>
        <button type="button" className={pillClass(dateTab === "repeat", !!when.repeat)} onClick={() => toggleTab("repeat")}>
          <RepeatIcon /> {when.repeat ? repeatLabel(when.repeat) : "Repeat"}
        </button>
        {!roomy && !showNotes && (
          <button type="button" className="tc-pill" onClick={() => setShowNotes(true)}>
            + Notes
          </button>
        )}
        {!roomy && !showSteps && (
          <button type="button" className="tc-pill" onClick={() => setShowSteps(true)}>
            + {cap(w.steps)}
          </button>
        )}
      </div>

      {dateTab && (
        <DateEditor
          tab={dateTab}
          date={when.someday ? null : when.date}
          time={when.time}
          repeat={when.repeat}
          evening={when.evening}
          someday={when.someday}
          deadline={when.deadline}
          now={now}
          locale={locale}
          onApply={applyWhen}
          onClose={() => {
            setDateTab(null);
            titleRef.current?.focus();
          }}
        />
      )}

      {places && (
        <PlacePicker
          places={places}
          building={newBuilding !== null ? "__new" : pickBuilding === undefined ? (at.project ?? extra?.project ?? null) : pickBuilding}
          floor={newFloor !== null ? "__new" : pickFloor === undefined ? (extra?.heading ?? null) : pickFloor}
          newBuilding={newBuilding}
          newFloor={newFloor}
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
        />
      )}

      <div className="add-task-foot">
        <span className="add-task-when">{where ? <span className="add-task-context">{where}</span> : roomy ? "Return adds · Esc cancels" : ""}</span>
        <button type="button" className="add-task-link quiet" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}

/** When a new task is planned, as the form holds it. */
interface When {
  date: string | null;
  time: string | null;
  repeat: string | null;
  deadline: string | null;
  someday: boolean;
  evening: boolean;
}

function pillClass(open: boolean, set: boolean): string {
  return ["tc-pill", set ? "set" : "", open ? "on" : ""].filter(Boolean).join(" ");
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

/** Building and floor pickers for a new task: the floors follow the building picked. */
export function PlacePicker(p: {
  places: { name: string; floors: string[] }[];
  building: string | null;
  floor: string | null;
  newBuilding: string | null;
  newFloor: string | null;
  onBuilding: (b: string | null) => void;
  onFloor: (f: string | null) => void;
  onNewBuilding: (n: string) => void;
  onNewFloor: (n: string) => void;
}) {
  const floors = p.places.find((x) => x.name === p.building)?.floors ?? [];
  const known = p.building === null || p.building === "__new" || p.places.some((x) => x.name === p.building);
  return (
    <div className="add-place">
      <label className="ap-field">
        <span>Project</span>
        {p.newBuilding !== null ? (
          <input autoFocus value={p.newBuilding} maxLength={60} placeholder="New project's name" onChange={(e) => p.onNewBuilding(e.target.value)} />
        ) : (
          <select value={p.building ?? ""} onChange={(e) => p.onBuilding(e.target.value || null)}>
            <option value="">No project (a house)</option>
            {!known && p.building && <option value={p.building}>{p.building} (new)</option>}
            {p.places.map((x) => (
              <option key={x.name} value={x.name}>
                {x.name}
              </option>
            ))}
            <option value="__new">+ New project…</option>
          </select>
        )}
      </label>
      <label className="ap-field">
        <span>Floor</span>
        {p.newFloor !== null ? (
          <input autoFocus value={p.newFloor} maxLength={60} placeholder="New floor's name" onChange={(e) => p.onNewFloor(e.target.value)} />
        ) : (
          <select value={p.floor ?? ""} disabled={!p.building} onChange={(e) => p.onFloor(e.target.value || null)}>
            <option value="">Ground floor</option>
            {floors.map((f) => (
              <option key={f} value={f}>
                {f}
              </option>
            ))}
            {p.building && <option value="__new">+ New floor…</option>}
          </select>
        )}
      </label>
    </div>
  );
}
