import { useEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { takeDuration } from "../lib/timeblock";
import { dayOrderForLocale } from "../lib/dates";
import { findSchedule } from "../lib/schedule";
import { isDeadlinePhrase } from "../lib/lists";
import { tagsOf, takePriority, toggleTag } from "../lib/taskText";
import { Checklist } from "./Checklist";
import { TaskFields, type FieldValues } from "./TaskFields";
import type { ProjectInfo } from "./ProjectPicker";
import type { ChecklistItem, NewTask, TaskPatch } from "../lib/types";

/**
 * Add a task: a title (dates, "p1" and "@Project" typed in it are understood
 * — "dentist fri 3pm p2"), notes, and one quiet row of chips and icons for
 * where it goes, when, priority, deadline, sub-tasks and tags. Return in
 * the title adds; ⌘Return adds from anywhere; Esc closes a menu, then cancels.
 */
export function AddTaskForm({
  locale,
  defaultDay,
  defaultPlace,
  placeholder,
  compact,
  extra,
  places = [],
  tags = [],
  onAdd,
  onCancel,
}: {
  locale: string;
  /** Day used when the title has no date (null: no date). */
  defaultDay: string | null;
  /** Where it goes unless the person picks or types somewhere else. */
  defaultPlace?: { project: string | null; heading: string | null };
  placeholder: string;
  /** Smaller, for the dropdown. */
  compact?: boolean;
  /** Set on every task added here. */
  extra?: Partial<NewTask>;
  /** Projects and their floors, to pick from (and for "@Project"). */
  places?: ProjectInfo[];
  /** Tags already in use, to pick from. */
  tags?: string[];
  /** Save the task. */
  onAdd: (task: NewTask) => Promise<void>;
  onCancel: () => void;
}) {
  const [title, setTitle] = useState("");
  const [notes, setNotes] = useState("");
  const [steps, setSteps] = useState<ChecklistItem[]>([]);
  const [showSteps, setShowSteps] = useState(false);
  const [busy, setBusy] = useState(false);
  // Fields picked by hand (over what's typed in the title and the defaults).
  const [over, setOver] = useState<Partial<FieldValues>>({});
  const titleRef = useRef<HTMLInputElement>(null);
  const notesRef = useRef<HTMLTextAreaElement>(null);
  const now = useMemo(() => new Date(), []);
  const order = useMemo(() => dayOrderForLocale(locale), [locale]);
  const names = useMemo(() => places.map((p) => p.name), [places]);

  useEffect(() => {
    titleRef.current?.focus();
  }, []);
  // Grow the notes box with its text.
  useEffect(() => {
    const el = notesRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 220)}px`;
  }, [notes]);

  // "@Project" files it there, "p1" sets its priority, a date phrase plans it.
  const at = useMemo(() => atProject(title, names), [title, names]);
  const pr = useMemo(() => takePriority(at.rest), [at.rest]);
  // "for 30 min" (or "for 1h30") sets how long it takes.
  const len = useMemo(() => takeDuration(pr.rest), [pr.rest]);
  const typed = useMemo(() => (len.rest.trim() ? findSchedule(len.rest, now, order) : null), [len.rest, now, order]);

  const auto: FieldValues = {
    project: at.project ?? extra?.project ?? defaultPlace?.project ?? null,
    heading: at.project ? null : (extra?.heading ?? defaultPlace?.heading ?? null),
    date: typed?.date ?? (extra?.someday ? null : (extra?.due_date ?? defaultDay)),
    time: typed?.date ? typed.time : null,
    evening: false,
    someday: !typed?.date && !!extra?.someday,
    repeat: typed?.repeat ?? null,
    deadline: typed?.date && isDeadlinePhrase(typed.matched) ? typed.date : (extra?.deadline ?? null),
    priority: pr.priority ?? 0,
    duration: len.minutes,
  };
  const v: FieldValues = { ...auto, ...over };

  function applyPatch(p: TaskPatch) {
    setOver((o) => {
      const n: Partial<FieldValues> = { ...o };
      if (p.project !== undefined) {
        n.project = p.project;
        n.heading = p.heading ?? null;
      } else if (p.heading !== undefined) n.heading = p.heading;
      if (p.someday) Object.assign(n, { someday: true, date: null, time: null, evening: false });
      if (p.due_date !== undefined) {
        Object.assign(n, { date: p.due_date, someday: false });
        if (p.due_date === null) Object.assign(n, { time: null, evening: false, repeat: null });
      }
      if (p.someday === false) n.someday = false;
      if (p.due_time !== undefined) n.time = p.due_time;
      if (p.evening !== undefined) n.evening = p.evening;
      if (p.recurrence !== undefined) n.repeat = p.recurrence;
      if (p.deadline !== undefined) n.deadline = p.deadline;
      if (p.priority !== undefined) n.priority = p.priority;
      if (p.duration !== undefined) n.duration = p.duration;
      return n;
    });
  }

  async function submit(e?: FormEvent) {
    e?.preventDefault();
    const clean = (typed?.title || len.rest).trim();
    if (!clean || busy) return;
    setBusy(true);
    try {
      await onAdd({
        ...extra,
        title: clean,
        due_date: v.someday ? null : v.date,
        due_time: v.date && !v.someday ? v.time : null,
        evening: !!v.date && v.evening,
        someday: v.someday,
        deadline: v.deadline,
        recurrence: v.date || !v.someday ? v.repeat : null,
        source_text: null,
        notes: notes.trim() || null,
        checklist: steps.filter((s) => s.text.trim()),
        project: v.project,
        heading: v.project ? v.heading : null,
        priority: v.priority,
        duration: v.duration ?? null,
      });
      setOver({});
      setTitle("");
      setNotes("");
      setSteps([]);
      setShowSteps(false);
      titleRef.current?.focus();
    } catch {
      // The caller showed the error; keep what was typed.
    } finally {
      setBusy(false);
    }
  }

  return (
    <form
      className={compact ? "add-task tfc compact" : "add-task tfc"}
      onSubmit={(e) => void submit(e)}
      onKeyDown={(e: KeyboardEvent) => {
        if (e.key === "Escape") {
          e.preventDefault();
          e.stopPropagation();
          onCancel();
        } else if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
          e.preventDefault();
          void submit();
        }
      }}
    >
      <input
        ref={titleRef}
        className="tfc-title"
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        placeholder={placeholder}
        maxLength={200}
        aria-label="Task"
      />
      <textarea
        ref={notesRef}
        className="tfc-notes"
        value={notes}
        onChange={(e) => setNotes(e.target.value)}
        placeholder="Notes"
        rows={1}
        maxLength={2000}
        aria-label="Notes"
      />
      {showSteps && (
        <div className="tfc-steps">
          <Checklist items={steps} onChange={setSteps} autoFocusAdd />
        </div>
      )}
      <div className="tfc-bar">
        <TaskFields
          value={v}
          onChange={applyPatch}
          places={places}
          now={now}
          locale={locale}
          tags={{ known: tags, active: tagsOf(title), onToggle: (t) => setTitle((x) => toggleTag(x, t)) }}
          steps={{ on: showSteps, onToggle: () => setShowSteps((s) => !s) }}
        />
        <button type="submit" className="tfc-add" disabled={!title.trim() || busy}>
          Add
        </button>
      </div>
    </form>
  );
}

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
            <option value="">No project</option>
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
        <span>Section</span>
        {p.newFloor !== null ? (
          <input autoFocus value={p.newFloor} maxLength={60} placeholder="Section name" onChange={(e) => p.onNewFloor(e.target.value)} />
        ) : (
          <select value={p.floor ?? ""} disabled={!p.building} onChange={(e) => p.onFloor(e.target.value || null)}>
            <option value="">General</option>
            {floors.map((f) => (
              <option key={f} value={f}>
                {f}
              </option>
            ))}
            {p.building && <option value="__new">+ New section…</option>}
          </select>
        )}
      </label>
    </div>
  );
}
