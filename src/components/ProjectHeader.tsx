import { useState } from "react";
import type { ProjectSummary } from "../lib/types";
import { Pie } from "./ListPicker";
import { useWords } from "../lib/words";

/** A project's title, progress, and its actions: add a heading, rename. */
export function ProjectHeader({
  name,
  stats,
  onAddUnder,
  onRename,
}: {
  name: string;
  stats: ProjectSummary | null;
  /** Start adding a task under a (new) heading. */
  onAddUnder: (heading: string | null) => void;
  onRename: (to: string) => Promise<void>;
}) {
  const w = useWords();
  const [mode, setMode] = useState<"heading" | "rename" | null>(null);
  const [text, setText] = useState("");
  const total = (stats?.open ?? 0) + (stats?.done ?? 0);

  function submit() {
    const v = text.trim();
    setText("");
    setMode(null);
    if (!v) return;
    if (mode === "heading") onAddUnder(v);
    else if (mode === "rename" && v !== name) void onRename(v);
  }

  return (
    <div className="project-head">
      <div className="ph-title">
        <Pie done={stats?.done ?? 0} total={total} size={18} />
        <div className="ph-text">
          <h2 title={name}>{name}</h2>
          {stats && (
            <span className="ph-count">
              {w.city ? `${w.project} · ` : ""}
              {w.progress(stats.open, stats.done)}
            </span>
          )}
        </div>
      </div>
      {mode ? (
        <input
          className="ph-input"
          autoFocus
          value={text}
          maxLength={60}
          placeholder={mode === "heading" ? `${w.heading} name, e.g. “Travel”` : `${w.project} name`}
          aria-label={mode === "heading" ? `New ${w.heading.toLowerCase()}` : `Rename ${w.project.toLowerCase()}`}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === "Enter") submit();
            if (e.key === "Escape") {
              setText("");
              setMode(null);
            }
          }}
          onBlur={submit}
        />
      ) : (
        <div className="ph-actions">
          <button type="button" className="ph-btn" onClick={() => setMode("heading")}>
            {w.newHeading}
          </button>
          <button
            type="button"
            className="ph-btn quiet"
            onClick={() => {
              setText(name);
              setMode("rename");
            }}
          >
            Rename
          </button>
        </div>
      )}
    </div>
  );
}
