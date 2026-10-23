import { useState } from "react";
import type { ProjectSummary } from "../lib/types";
import { Pie } from "./ListPicker";

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
        <h2 title={name}>{name}</h2>
        {stats && (
          <span className="ph-count">
            {stats.open} open · {stats.done} done
          </span>
        )}
      </div>
      {mode ? (
        <input
          className="ph-input"
          autoFocus
          value={text}
          maxLength={60}
          placeholder={mode === "heading" ? "Heading name, e.g. “Travel”" : "Project name"}
          aria-label={mode === "heading" ? "New heading" : "Rename project"}
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
            + Heading
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
