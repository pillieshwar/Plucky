import type { SnoozeKind } from "../lib/taskActions";

const OPTIONS: { kind: SnoozeKind; label: string }[] = [
  { kind: "15m", label: "15 min" },
  { kind: "1h", label: "1 hour" },
  { kind: "tonight", label: "Tonight" },
  { kind: "tomorrow", label: "Tomorrow" },
  { kind: "week", label: "Next week" },
];

/** One-tap snooze choices, shown inline under a task. */
export function SnoozeBar({
  onSnooze,
  onDone,
  compact,
}: {
  onSnooze: (kind: SnoozeKind) => void;
  /** Show a Done button first (for reminders that just fired). */
  onDone?: () => void;
  compact?: boolean;
}) {
  const now = new Date();
  // "Tonight" only before 7 pm; compact keeps the three most used.
  const options = compact
    ? OPTIONS.filter((o) => o.kind === "15m" || o.kind === "1h" || o.kind === "tomorrow")
    : OPTIONS.filter((o) => o.kind !== "tonight" || now.getHours() < 19);
  return (
    <div className="snooze-bar" role="group" aria-label="Snooze">
      {onDone && (
        <button type="button" className="sn-chip done" onClick={onDone}>
          Done
        </button>
      )}
      {options.map((o) => (
        <button key={o.kind} type="button" className="sn-chip" onClick={() => onSnooze(o.kind)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}
