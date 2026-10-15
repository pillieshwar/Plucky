import { SnoozeBar } from "./SnoozeBar";
import { dueChip } from "../lib/due";
import type { TaskActions } from "../lib/taskActions";
import type { Task } from "../lib/types";

/**
 * Reminders that just went off, each with Done and snooze choices right
 * there — no menus. Shown at the top of the panel and the menu-bar popover.
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
  if (!tasks.length) return null;
  return (
    <section className={compact ? "due-now compact" : "due-now"} aria-label="Due now">
      <p className="due-now-h">
        <span className="due-now-dot" aria-hidden /> Due now
      </p>
      <ul>
        {tasks.slice(0, 3).map((t) => {
          const chip = dueChip(t, now, locale);
          return (
            <li key={t.id}>
              <div className="due-now-title">
                <span>{t.title}</span>
                {chip && <span className={`due-chip ${chip.tone}`}>{chip.label}</span>}
              </div>
              <SnoozeBar
                compact={compact}
                onDone={() => void actions.setDone(t, true)}
                onSnooze={(kind) => void actions.snooze(t, kind)}
              />
            </li>
          );
        })}
      </ul>
      {tasks.length > 3 && <p className="due-now-more">and {tasks.length - 3} more</p>}
    </section>
  );
}
