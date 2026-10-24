import { type ReactElement, useEffect, useRef, useState } from "react";
import { listTitle, projectList, projectOf, type ListId } from "../lib/lists";
import type { ProjectSummary } from "../lib/types";

/**
 * The panel's title, which is also the list menu: Today, Upcoming, Anytime,
 * Someday, Logbook, then projects and tags.
 */
export function ListPicker({
  value,
  onChange,
  counts,
  projects,
  tags,
  onTag,
}: {
  value: ListId;
  onChange: (id: ListId) => void;
  counts: { all: number; today: number; someday: number };
  projects: ProjectSummary[];
  tags: string[];
  onTag: (tag: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const project = projectOf(value);

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
  const item = (id: ListId, text: string, count: number | null, icon: ReactElement, hint?: string) => (
    <button
      key={id}
      type="button"
      role="menuitemradio"
      aria-checked={value === id}
      className={value === id ? "lp-item on" : "lp-item"}
      onClick={() => pick(id)}
    >
      <span className="lp-icon" aria-hidden>
        {icon}
      </span>
      <span className="lp-text">{text}</span>
      {hint && <span className="lp-hint">{hint}</span>}
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
        className={open ? "list-title on" : "list-title"}
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="menu"
        aria-expanded={open}
        title="Choose a list"
      >
        {project !== null && (
          <Pie
            done={projects.find((p) => p.name === project)?.done ?? 0}
            total={(projects.find((p) => p.name === project)?.done ?? 0) + (projects.find((p) => p.name === project)?.open ?? 0)}
            size={18}
          />
        )}
        <span className="lt-text">{listTitle(value)}</span>
        <svg className="lt-caret" width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
          <path d={open ? "M4 10l4-4 4 4" : "M4 6l4 4 4-4"} strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      {open && (
        <div className="lp-menu" role="menu" aria-label="Lists">
          {item("today", "Today", counts.today, <StarIcon />)}
          {item("upcoming", "Upcoming", null, <CalIcon />, "week · hours")}
          {item("all", "Anytime", counts.all, <LinesIcon />)}
          {item("someday", "Someday", counts.someday, <CloudIcon />)}
          {item("logbook", "Logbook", null, <LogIcon />)}
          <div className="lp-sep">Projects</div>
          {projects.length === 0 && <p className="lp-empty">Open a task and choose “Project” to start one.</p>}
          {projects.map((p) => (
            <button
              key={p.name}
              type="button"
              role="menuitemradio"
              aria-checked={project === p.name}
              className={project === p.name ? "lp-item on" : "lp-item"}
              onClick={() => pick(projectList(p.name))}
            >
              <span className="lp-icon" aria-hidden>
                <Pie done={p.done} total={p.open + p.done} />
              </span>
              <span className="lp-text">{p.name}</span>
              {p.open > 0 && <span className="lp-count">{p.open}</span>}
            </button>
          ))}
          {tags.length > 0 && (
            <>
              <div className="lp-sep">Tags</div>
              <div className="lp-tags">
                {tags.map((t) => (
                  <button
                    key={t}
                    type="button"
                    className="lp-tag"
                    onClick={() => {
                      onTag(t);
                      setOpen(false);
                    }}
                  >
                    {t}
                  </button>
                ))}
              </div>
            </>
          )}
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
  const ri = r - 1.6;
  return (
    <svg className="pie" width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-label={`${done} of ${total} done`}>
      <circle cx={c} cy={c} r={r} fill="none" stroke="currentColor" strokeWidth="1.4" />
      {frac >= 1 ? (
        <circle cx={c} cy={c} r={ri} fill="currentColor" />
      ) : frac > 0 ? (
        <path
          d={`M${c} ${c} L${c} ${c - ri} A${ri} ${ri} 0 ${frac > 0.5 ? 1 : 0} 1 ${c + ri * Math.sin(angle)} ${c - ri * Math.cos(angle)} Z`}
          fill="currentColor"
        />
      ) : null}
    </svg>
  );
}

const sv = { width: 15, height: 15, viewBox: "0 0 16 16", fill: "none", stroke: "currentColor", strokeWidth: 1.6, "aria-hidden": true } as const;
function StarIcon() {
  return (
    <svg {...sv} fill="currentColor" stroke="none">
      <path d="M8 1.5l1.9 4 4.4.5-3.3 3 .9 4.3L8 11.1l-3.9 2.2.9-4.3-3.3-3 4.4-.5Z" />
    </svg>
  );
}
function CalIcon() {
  return (
    <svg {...sv}>
      <rect x="2" y="3" width="12" height="11" rx="2" />
      <path d="M2 6.5h12M5.5 1.5v3M10.5 1.5v3" strokeLinecap="round" />
    </svg>
  );
}
function LinesIcon() {
  return (
    <svg {...sv}>
      <path d="M3 4.5h10M3 8h10M3 11.5h10" strokeLinecap="round" />
    </svg>
  );
}
function CloudIcon() {
  return (
    <svg {...sv}>
      <path d="M4.5 12.5h7a3 3 0 0 0 .3-6 4 4 0 0 0-7.6-.8A3.4 3.4 0 0 0 4.5 12.5Z" strokeLinejoin="round" />
    </svg>
  );
}
function LogIcon() {
  return (
    <svg {...sv} strokeWidth={1.8}>
      <rect x="2" y="2" width="12" height="12" rx="3" />
      <path d="M5 8.3l2 2 4-4.3" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
