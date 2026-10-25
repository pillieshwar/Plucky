import { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "../lib/api";
import { Toggle } from "./GeneralSettings";
import type { ImportReport, ThingsOptions, ThingsPreview } from "../lib/types";

type Phase =
  | { kind: "idle" }
  | { kind: "reading" }
  | { kind: "preview"; data: ThingsPreview }
  | { kind: "moving"; data: ThingsPreview }
  | { kind: "done"; report: ImportReport }
  | { kind: "error"; message: string };

const n = (x: number) => x.toLocaleString();
const plural = (x: number, one: string, many = `${one}s`) => `${n(x)} ${x === 1 ? one : many}`;

/** What goes where, Things 3 → Todo City. */
const MAP: [string, string][] = [
  ["Project", "Project (a building)"],
  ["Heading", "Floor"],
  ["To-do", "Task (a home)"],
  ["Checklist", "Sub-tasks"],
  ["Area", "Its projects come as they are; to-dos sitting right in the area become a project named after it"],
  ["Inbox and loose to-dos", "Tasks with no project (houses)"],
  ["Today, This Evening, Upcoming", "The same day (and evening)"],
  ["Anytime", "No day"],
  ["Someday", "Someday"],
  ["Deadline", "Deadline"],
  ["Reminder time", "Time of day"],
  ["Repeating to-do", "Repeat — daily, weekdays, weekly, every 2 weeks, monthly, yearly"],
  ["Notes", "Notes"],
  ["Tags", "#tags on the task"],
  ["Logbook", "Done tasks — lit windows in your city"],
];

/**
 * Data transfer: move everything in from another app. Things 3 first — it
 * keeps its database on this Mac, so nothing goes online.
 */
export function DataTransferTab({ onFinished }: { onFinished: () => void }) {
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const [path, setPath] = useState<string | null>(null);
  const [includeDone, setIncludeDone] = useState(true);
  const [includeCanceled, setIncludeCanceled] = useState(false);
  const [skip, setSkip] = useState<Set<string>>(new Set());

  const options = useCallback(
    (): ThingsOptions => ({ include_done: includeDone, include_canceled: includeCanceled, skip: [...skip] }),
    [includeDone, includeCanceled, skip],
  );

  const read = useCallback(
    async (p: string | null, opts: ThingsOptions) => {
      setPhase({ kind: "reading" });
      try {
        setPhase({ kind: "preview", data: await api.thingsPreview(p, opts) });
      } catch (e) {
        setPhase({ kind: "error", message: String(e) });
      }
    },
    [],
  );

  // The counts depend on these two, so read again when they change.
  const previewing = phase.kind === "preview";
  useEffect(() => {
    if (previewing) void read(path, { include_done: includeDone, include_canceled: includeCanceled, skip: [] });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [includeDone, includeCanceled]);

  async function pick() {
    try {
      const p = await api.thingsPick();
      if (!p) return;
      setPath(p);
      setSkip(new Set());
      await read(p, options());
    } catch (e) {
      setPhase({ kind: "error", message: String(e) });
    }
  }

  async function move(data: ThingsPreview) {
    setPhase({ kind: "moving", data });
    try {
      setPhase({ kind: "done", report: await api.thingsImport(path, options()) });
    } catch (e) {
      setPhase({ kind: "error", message: String(e) });
    }
  }

  const data = phase.kind === "preview" || phase.kind === "moving" ? phase.data : null;
  const chosen = useMemo(() => {
    if (!data) return { open: 0, done: 0, buildings: 0 };
    const on = data.preview.buildings.filter((b) => !skip.has(b.key));
    const open = on.reduce((s, b) => s + b.open, 0);
    const done = on.reduce((s, b) => s + b.done, 0);
    return { open, done, buildings: on.filter((b) => b.kind !== "loose").length };
  }, [data, skip]);
  // The counts are only what's new: earlier imports are left out already.
  const toMove = chosen.open + chosen.done;

  return (
    <div className="transfer">
      <header className="tr-hero">
        <ThingsGlyph />
        <div>
          <h2 className="tr-title">Move in from Things 3</h2>
          <p className="tr-sub">
            Bring your projects, headings, to-dos, checklists and Logbook into Todo City. Everything happens on this
            Mac — Things isn't changed, and nothing goes online.
          </p>
        </div>
      </header>

      {phase.kind !== "done" && (
        <ol className="tr-steps">
          <li>
            <b>Open Things 3 on this Mac</b> and let it finish syncing, so this Mac has all your to-dos. Only use
            Things on iPhone or iPad? Install Things 3 for Mac and sign in to Things Cloud first.
          </li>
          <li>
            <b>Click Find my Things library.</b> If macOS asks whether Todo City may access data from other apps,
            click <b>Allow</b>.
          </li>
          <li>
            <b>Check the preview.</b> Untick any project you'd rather leave behind, and choose whether to bring your
            Logbook.
          </li>
          <li>
            <b>Click Move in.</b> Todo City backs itself up first. You can keep using Things and move in again later —
            only new to-dos come across.
          </li>
        </ol>
      )}

      {(phase.kind === "idle" || phase.kind === "error" || phase.kind === "reading") && (
        <div className="tr-actions">
          <button
            type="button"
            className="primary"
            disabled={phase.kind === "reading"}
            onClick={() => void read(path, options())}
          >
            {phase.kind === "reading" ? "Reading Things…" : "Find my Things library"}
          </button>
          <button type="button" className="ghost" disabled={phase.kind === "reading"} onClick={() => void pick()}>
            Choose the database myself…
          </button>
        </div>
      )}

      {phase.kind === "error" && (
        <div className="tr-error" role="alert">
          <p>{phase.message}</p>
          <details>
            <summary>Where is the Things database?</summary>
            <p>
              In Finder, choose <b>Go → Go to Folder…</b> and paste
              <code>~/Library/Group Containers/JLMPQHK86H.com.culturedcode.ThingsMac</code>
              Open the <b>ThingsData-…</b> folder inside (older versions don't have one) and pick{" "}
              <b>Things Database.thingsdatabase</b>. Copying it to your Desktop first and choosing the copy works too.
            </p>
          </details>
        </div>
      )}

      {data && (
        <section className="tr-preview" aria-label="What will move in">
          <p className="tr-found" title={data.source.path}>
            Found your Things library
            {data.source.modified && <> · saved {new Date(data.source.modified).toLocaleString()}</>}
          </p>
          <div className="tr-stats">
            <Stat value={chosen.open} label="to do" />
            <Stat value={chosen.done} label="done" />
            <Stat value={chosen.buildings} label="projects" />
            <Stat value={data.preview.subtasks} label="sub-tasks" />
          </div>

          <div className="tr-options">
            <Toggle
              checked={includeDone}
              onChange={setIncludeDone}
              label="Bring the Logbook"
              hint="Finished to-dos come as done tasks — each one a lit window in your city."
            />
            <Toggle
              checked={includeCanceled}
              onChange={setIncludeCanceled}
              label="Bring cancelled to-dos"
              hint={`As done tasks.${data.preview.canceled ? ` ${plural(data.preview.canceled, "cancelled to-do")} would stay behind otherwise.` : ""}`}
            />
          </div>

          <h3 className="tr-h">Buildings</h3>
          <ul className="tr-list">
            {data.preview.buildings.map((b) => {
              const on = !skip.has(b.key);
              return (
                <li key={b.key || "loose"} className={on ? "" : "off"}>
                  <label>
                    <input
                      type="checkbox"
                      checked={on}
                      onChange={() =>
                        setSkip((s) => {
                          const next = new Set(s);
                          if (next.has(b.key)) next.delete(b.key);
                          else next.add(b.key);
                          return next;
                        })
                      }
                    />
                    <span className="tr-name">
                      {b.kind === "loose" ? "No project — Inbox and loose to-dos (houses)" : b.name}
                      {b.area && <span className="tr-tag">{b.area}</span>}
                      {b.kind === "area" && <span className="tr-tag">area</span>}
                    </span>
                    <span className="tr-count">
                      {[
                        b.open && `${n(b.open)} to do`,
                        includeDone && b.done && `${n(b.done)} done`,
                        b.floors && plural(b.floors, "floor"),
                      ]
                        .filter(Boolean)
                        .join(" · ") || "empty"}
                    </span>
                  </label>
                </li>
              );
            })}
          </ul>

          <ul className="tr-notes">
            {data.preview.already > 0 && (
              <li>{plural(data.preview.already, "to-do")} moved in earlier — they won't be added twice.</li>
            )}
            {data.preview.someday > 0 && <li>{plural(data.preview.someday, "to-do")} go to Someday.</li>}
            {data.preview.repeating > 0 && <li>{plural(data.preview.repeating, "repeating to-do")} keep their repeat.</li>}
            {data.preview.unmapped_repeats > 0 && (
              <li>
                {plural(data.preview.unmapped_repeats, "repeat")} use a pattern Todo City doesn't have yet; they come
                once, with a note to set a repeat.
              </li>
            )}
          </ul>

          <div className="tr-actions">
            <button
              type="button"
              className="primary"
              disabled={phase.kind === "moving" || toMove === 0}
              onClick={() => void move(data)}
            >
              {phase.kind === "moving"
                ? "Moving in…"
                : toMove === 0
                  ? "Nothing new to move in"
                  : `Move in ${plural(toMove, "to-do")}`}
            </button>
            <button type="button" className="ghost" disabled={phase.kind === "moving"} onClick={() => void pick()}>
              Use a different database…
            </button>
          </div>
        </section>
      )}

      {phase.kind === "done" && (
        <section className="tr-done" aria-live="polite">
          <h3>Welcome home.</h3>
          <p>
            {phase.report.added
              ? `${plural(phase.report.added, "to-do")} moved in${phase.report.done ? ` — ${plural(phase.report.done, "window")} lit up in your city` : ""}.`
              : "Everything was already here — nothing new to move in."}
            {phase.report.skipped > 0 && ` ${plural(phase.report.skipped, "to-do")} were already here.`}
            {phase.report.failed > 0 && ` ${plural(phase.report.failed, "to-do")} couldn't be read and stayed in Things.`}
          </p>
          <p className="tr-small">
            A backup from just before is in Preferences → Your data, if you want to undo this. Moved-in tasks aren't
            sent to Apple Reminders on their own.
          </p>
          <div className="tr-actions">
            <button type="button" className="primary" onClick={onFinished}>
              See your tasks
            </button>
            <button type="button" className="ghost" onClick={() => setPhase({ kind: "idle" })}>
              Move in again
            </button>
          </div>
        </section>
      )}

      <details className="tr-map">
        <summary>What goes where</summary>
        <table>
          <thead>
            <tr>
              <th>Things 3</th>
              <th>Todo City</th>
            </tr>
          </thead>
          <tbody>
            {MAP.map(([a, b]) => (
              <tr key={a}>
                <td>{a}</td>
                <td>{b}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="tr-small">Trashed to-dos stay behind. Projects you've finished come with their to-dos as done.</p>
      </details>

      <div className="tr-soon">
        <span className="tr-soon-name">Todoist</span>
        <span className="tr-tag">coming soon</span>
      </div>
    </div>
  );
}

function Stat({ value, label }: { value: number; label: string }) {
  return (
    <div className="tr-stat">
      <b>{n(value)}</b>
      <span>{label}</span>
    </div>
  );
}

/** A plain check-in-a-square mark (not Things' own logo). */
function ThingsGlyph() {
  return (
    <svg className="tr-glyph" viewBox="0 0 40 40" aria-hidden="true">
      <rect x="2" y="2" width="36" height="36" rx="9" fill="#2f7bf5" />
      <rect x="10" y="10" width="20" height="20" rx="4" fill="none" stroke="#fff" strokeWidth="2.6" />
      <path d="M14.5 20.5l4 4 7-8" fill="none" stroke="#fff" strokeWidth="2.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
