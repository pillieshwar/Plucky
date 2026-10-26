import { relativeLabel } from "../lib/dates";
import { hourLabel } from "../lib/plan";
import type { DragState } from "../lib/useTaskDrag";

/** The label that follows the pointer while a task is dragged: where it will land. */
export function DragGhost({ drag, now, locale }: { drag: DragState; now: Date; locale: string }) {
  const o = drag.over;
  const where = o?.place
    ? [o.place.project, o.place.heading === undefined ? null : (o.place.heading ?? "Ground floor")].filter(Boolean).join(" › ")
    : o?.iso
    ? [
        relativeLabel(o.iso, now, locale),
        o.hour === null ? "any time" : o.hour === undefined ? null : hourLabel(o.hour, locale),
      ]
        .filter(Boolean)
        .join(", ")
    : null;
  return (
    <div
      className="pop-ghost"
      style={{ left: Math.max(8, Math.min(drag.x - 40, window.innerWidth - 236)), top: drag.y + 14 }}
      aria-hidden
    >
      {drag.task.title}
      {where && <span> → {where}</span>}
    </div>
  );
}
