import { useState } from "react";
import { addDays, toISODate } from "../lib/dates";
import type { TaskActions } from "../lib/taskActions";
import type { Task } from "../lib/types";
import { ProjectPicker, type ProjectInfo } from "./ProjectPicker";

/**
 * Shown while several tasks are selected (⌘-click or Shift-click rows):
 * complete, move, park, file or delete them in one go — one Undo for all.
 */
export function BatchBar({
  tasks,
  actions,
  projects,
  onClear,
}: {
  tasks: Task[];
  actions: TaskActions;
  projects: ProjectInfo[];
  onClear: () => void;
}) {
  const [filing, setFiling] = useState(false);
  const n = tasks.length;
  const label = n === 1 ? "1 task" : `${n} tasks`;
  const repeating = tasks.filter((t) => t.recurrence);
  const anyPaused = repeating.some((t) => t.paused);
  const day = (offset: number) => toISODate(addDays(new Date(), offset));
  const run = (p: Promise<void>) => {
    void p.then(onClear);
  };

  return (
    <div className="batch" role="toolbar" aria-label={`${label} selected`}>
      {filing && (
        <div className="batch-pop">
          <ProjectPicker
            projects={projects}
            project={null}
            heading={null}
            onPick={(project, heading) => {
              setFiling(false);
              run(actions.batch(tasks, { project, heading }, project ? `Moved ${label} to ${project}` : `Took ${label} out of their project`));
            }}
          />
        </div>
      )}
      <span className="batch-count">{label}</span>
      <div className="batch-actions">
        <button type="button" onClick={() => run(actions.completeMany(tasks))} title="Complete (Space)">
          ✓ Done
        </button>
        <button
          type="button"
          onClick={() => run(actions.batch(tasks, { due_date: day(0), evening: false }, `Moved ${label} to today`))}
          title="Move to today (T)"
        >
          Today
        </button>
        <button
          type="button"
          onClick={() => run(actions.batch(tasks, { due_date: day(1) }, `Moved ${label} to tomorrow`))}
          title="Move to tomorrow (M)"
        >
          Tomorrow
        </button>
        <button
          type="button"
          onClick={() =>
            run(actions.batch(tasks, { someday: true, due_date: null, due_time: null }, `Parked ${label} in Someday`))
          }
          title="Park in Someday"
        >
          Someday
        </button>
        <button type="button" className={filing ? "on" : ""} onClick={() => setFiling((f) => !f)} aria-expanded={filing} title="Move to a project">
          Project…
        </button>
        {repeating.length > 0 && (
          <button
            type="button"
            onClick={() =>
              run(
                Promise.all(repeating.map((t) => actions.pause(t, !anyPaused))).then(() => undefined),
              )
            }
            title={anyPaused ? "Resume the repeating ones" : "Pause the repeating ones (no reminders)"}
          >
            {anyPaused ? "Resume" : "Pause"}
          </button>
        )}
        {repeating.length > 0 && (
          <button
            type="button"
            onClick={() => run(actions.batch(repeating, { recurrence: null }, `Stopped repeating ${repeating.length === 1 ? "1 task" : `${repeating.length} tasks`}`))}
            title="Keep them, stop making new ones"
          >
            Stop repeating
          </button>
        )}
        <button type="button" className="danger" onClick={() => run(actions.removeMany(tasks))} title="Delete (⌫)">
          Delete
        </button>
      </div>
      <button type="button" className="batch-close" onClick={onClear} aria-label="Clear selection (Esc)" title="Clear selection (Esc)">
        ×
      </button>
    </div>
  );
}
