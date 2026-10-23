import { useEffect, useRef, useState } from "react";
import { projectList, projectOf, type ListId } from "../lib/lists";
import type { ProjectSummary } from "../lib/types";
import { FolderIcon } from "./ProjectPicker";

/**
 * Which list the panel shows: All, Today, Someday, Logbook, or a project.
 * One button with a menu, so the toolbar stays a single row.
 */
export function ListPicker({
  value,
  onChange,
  counts,
  projects,
}: {
  value: ListId;
  onChange: (id: ListId) => void;
  counts: { all: number; today: number; someday: number };
  projects: ProjectSummary[];
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const project = projectOf(value);
  const label = project ?? { all: "All", today: "Today", someday: "Someday", logbook: "Logbook" }[value as "all"];

  useEffect(() => {
    if (!open) return;
    const close = (e: PointerEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", close, true);
    return () => document.removeEventListener("pointerdown", close, true);
  }, [open]);

  const pick = (id: ListId) => {
    onChange(id);
    setOpen(false);
  };
  const item = (id: ListId, text: string, count: number | null, icon: string) => (
    <button key={id} type="button" role="menuitemradio" aria-checked={value === id} className={value === id ? "lp-item on" : "lp-item"} onClick={() => pick(id)}>
      <span className="lp-icon" aria-hidden>
        {icon}
      </span>
      <span className="lp-text">{text}</span>
      {count !== null && count > 0 && <span className="lp-count">{count}</span>}
    </button>
  );

  return (
    <div
      className="list-picker"
      ref={ref}
      onKeyDown={(e) => {
        if (e.key === "Escape" && open) {
          e.stopPropagation();
          setOpen(false);
        }
      }}
    >
      <button
        type="button"
        className={value === "all" ? "focus-toggle" : "focus-toggle on"}
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="menu"
        aria-expanded={open}
        title="Show a list: Today, Someday, Logbook or a project (F: Today)"
      >
        {project ? <FolderIcon /> : <span className="focus-dot" aria-hidden />}
        <span className="lp-label">{label}</span>
        <span aria-hidden className="lp-caret">
          ▾
        </span>
      </button>
      {open && (
        <div className="lp-menu" role="menu" aria-label="Lists">
          {item("all", "All tasks", counts.all, "◎")}
          {item("today", "Today", counts.today, "★")}
          {item("someday", "Someday", counts.someday, "☁")}
          {item("logbook", "Logbook", null, "✓")}
          <div className="lp-sep">Projects</div>
          {projects.length === 0 && <p className="lp-empty">Use the folder button on a task to start a project.</p>}
          {projects.map((p) => (
            <button
              key={p.name}
              type="button"
              role="menuitemradio"
              aria-checked={project === p.name}
              className={project === p.name ? "lp-item on" : "lp-item"}
              onClick={() => pick(projectList(p.name))}
            >
              <Pie done={p.done} total={p.open + p.done} />
              <span className="lp-text">{p.name}</span>
              {p.open > 0 && <span className="lp-count">{p.open}</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** A small progress pie: how much of a project is done. */
export function Pie({ done, total, size = 14 }: { done: number; total: number; size?: number }) {
  const r = size / 2 - 1.5;
  const frac = total ? done / total : 0;
  const c = size / 2;
  const angle = frac * 2 * Math.PI;
  return (
    <svg className="pie" width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-label={`${done} of ${total} done`}>
      <circle cx={c} cy={c} r={r} fill="none" stroke="currentColor" strokeWidth="1.4" />
      {frac >= 1 ? (
        <circle cx={c} cy={c} r={r - 1.6} fill="currentColor" />
      ) : frac > 0 ? (
        <path d={`M${c} ${c} L${c} ${c - r + 1.6} A${r - 1.6} ${r - 1.6} 0 ${frac > 0.5 ? 1 : 0} 1 ${c + (r - 1.6) * Math.sin(angle)} ${c - (r - 1.6) * Math.cos(angle)} Z`} fill="currentColor" />
      ) : null}
    </svg>
  );
}
