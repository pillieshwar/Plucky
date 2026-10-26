import { useState } from "react";
import { SnoozeBar } from "./SnoozeBar";
import { dueChip } from "../lib/due";
import type { TaskActions } from "../lib/taskActions";
import type { Task } from "../lib/types";

/**
 * Reminders that just went off, as one slim strip each: the task, Done, and
 * Later (snooze choices). Shown at the top of the panel and the dropdown.
 */
export function DueNowCard({
  tasks,
  actions,
  now,
  locale,
  compact,
}: {
  tasks: Task[];
  actions: TaskActions;
  now: Date;
  locale: string;
  compact?: boolean;
}) {
  const [later, setLater] = useState<number | null>(null);
  if (!tasks.length) return null;
  return (
    <section className={compact ? "due-now compact" : "due-now"} aria-label="Due now">
      {tasks.slice(0, 3).map((t) => {
        const chip = dueChip(t, now, locale);
        const when = chip?.label.replace(/^Overdue · /, "was ") ?? null;
        return (
          <div key={t.id} className="due-strip">
            <div className="due-line">
              <span className="due-now-dot" aria-hidden />
              <span className="due-text">
                <strong>{t.title}</strong>
                {when && <span> · {when}</span>}
              </span>
              <button type="button" className="due-done" onClick={() => void actions.setDone(t, true)}>
                Done
              </button>
              <button
                type="button"
                className={later === t.id ? "due-later on" : "due-later"}
                onClick={() => setLater((l) => (l === t.id ? null : t.id))}
                aria-expanded={later === t.id}
              >
                Later
              </button>
            </div>
            {later === t.id && (
              <SnoozeBar
                compact={compact}
                onSnooze={(kind) => {
                  setLater(null);
                  void actions.snooze(t, kind);
                }}
              />
            )}
          </div>
        );
      })}
      {tasks.length > 3 && <p className="due-now-more">and {tasks.length - 3} more</p>}
    </section>
  );
}
