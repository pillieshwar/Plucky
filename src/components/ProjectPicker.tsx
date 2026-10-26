import { useWords } from "../lib/words";
import { useState } from "react";

export interface ProjectInfo {
  name: string;
  headings: string[];
}

/**
 * Put a task in a project (and a heading in it), make a new one, or take it
 * out. Shown inline under the task.
 */
export function ProjectPicker({
  projects,
  project,
  heading,
  onPick,
}: {
  projects: ProjectInfo[];
  project: string | null;
  heading: string | null;
  onPick: (project: string | null, heading: string | null) => void;
}) {
  const w = useWords();
  const [creating, setCreating] = useState<"project" | "heading" | null>(projects.length ? null : "project");
  const [name, setName] = useState("");
  const current = projects.find((p) => p.name === project);

  function submit() {
    const n = name.trim();
    if (!n) return setCreating(null);
    if (creating === "project") onPick(n, null);
    else if (creating === "heading" && project) onPick(project, n);
    setName("");
    setCreating(null);
  }

  return (
    <div className="project-picker" role="group" aria-label={w.project}>
      <div className="pp-chips">
        {projects.map((p) => (
          <button
            key={p.name}
            type="button"
            className={p.name === project && !heading ? "pp-chip on" : p.name === project ? "pp-chip in" : "pp-chip"}
            onClick={() => onPick(p.name, null)}
          >
            <FolderIcon /> {p.name}
          </button>
        ))}
        {creating === "project" ? (
          <NameField placeholder={w.newProjectName} value={name} onChange={setName} onSubmit={submit} onCancel={() => setCreating(null)} />
        ) : (
          <button type="button" className="pp-chip new" onClick={() => setCreating("project")}>
            {w.newProject}
          </button>
        )}
        {project && (
          <button type="button" className="pp-chip clear" onClick={() => onPick(null, null)}>
            {w.noProject}
          </button>
        )}
      </div>
      {project && (
        <div className="pp-headings">
          <span className="pp-label">{w.headingIn(project)}</span>
          {(current?.headings ?? []).map((h) => (
            <button
              key={h}
              type="button"
              className={h === heading ? "pp-chip small on" : "pp-chip small"}
              onClick={() => onPick(project, h === heading ? null : h)}
            >
              {h}
            </button>
          ))}
          {creating === "heading" ? (
            <NameField placeholder={`New ${w.heading.toLowerCase()}`} value={name} onChange={setName} onSubmit={submit} onCancel={() => setCreating(null)} />
          ) : (
            <button type="button" className="pp-chip small new" onClick={() => setCreating("heading")}>
              {w.newHeading}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function NameField({
  placeholder,
  value,
  onChange,
  onSubmit,
  onCancel,
}: {
  placeholder: string;
  value: string;
  onChange: (v: string) => void;
  onSubmit: () => void;
  onCancel: () => void;
}) {
  return (
    <input
      className="pp-input"
      autoFocus
      value={value}
      maxLength={60}
      placeholder={placeholder}
      aria-label={placeholder}
      onChange={(e) => onChange(e.target.value)}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Enter") onSubmit();
        if (e.key === "Escape") onCancel();
      }}
      onBlur={onSubmit}
    />
  );
}

export function FolderIcon() {
  return (
    <svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden>
      <path d="M2 4.5A1.5 1.5 0 0 1 3.5 3h3l1.5 1.5h4.5A1.5 1.5 0 0 1 14 6v5.5a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 2 11.5v-7Z" strokeLinejoin="round" />
    </svg>
  );
}

export function StepsIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden>
      <path d="M2.5 4l1.2 1.2L6 3M2.5 10l1.2 1.2L6 9M8.5 4.5h5M8.5 10.5h5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function FlagIcon() {
  return (
    <svg width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden>
      <path d="M3.5 14V2.5M3.5 3h8l-1.8 3 1.8 3h-8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function MoonIcon() {
  return (
    <svg width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden>
      <path d="M13 9.5A5.5 5.5 0 0 1 6.5 3a5.5 5.5 0 1 0 6.5 6.5Z" strokeLinejoin="round" />
    </svg>
  );
}
