import { useWords } from "../lib/words";
import { useEffect, useState, type ReactElement } from "react";
import { projectList, projectOf, type ListId } from "../lib/lists";
import type { ProjectSummary } from "../lib/types";
import { CalIcon, CloudIcon, LinesIcon, LogIcon, Pie, StarIcon } from "./ListPicker";
import { GearIcon, SearchIcon } from "./icons";
import { initials, type Building } from "../lib/city";

interface Props {
  list: ListId;
  /** Settings is showing instead of a list. */
  inSettings: boolean;
  onList: (id: ListId) => void;
  counts: { all: number; today: number; someday: number };
  projects: ProjectSummary[];
  tags: string[];
  activeTags: string[];
  onTag: (tag: string) => void;
  onSearch: () => void;
  onSettings: () => void;
  onKeys: () => void;
  /** Open the city. */
  onCity: () => void;
  cityName: string | null;
  mayor: string | null;
  /** Rooms lit in all (finished tasks). */
  lit: number;
  /** The city's buildings (projects), with their floors stacked as drawn. */
  buildings: Building[];
  /** Open a building at one of its floors (null: the lobby). */
  onFloor: (project: string, floor: string | null) => void;
  /** The floor whose page is showing. */
  floorOn: { project: string; floor: string | null } | null;
  onNewBuilding: (name: string) => void;
  onNewFloor: (project: string, name: string) => void;
  updateReady: boolean;
  model: string | null;
  captureHint: ReactElement;
  /** The window's close, minimize and zoom buttons. */
  lights: ReactElement;
}

/**
 * Full screen's sidebar: search, the lists (Today, Calendar, Anytime,
 * Someday, Logbook), projects with their progress, tags, and — at the
 * bottom — what's reading captures and Settings.
 */
export function Sidebar(p: Props) {
  const w = useWords();
  const project = projectOf(p.list);
  // Buildings opened to show their floors; the one being viewed opens itself.
  const [openB, setOpenB] = useState<Set<string>>(() => new Set());
  const [adding, setAdding] = useState<{ kind: "building" } | { kind: "floor"; project: string } | null>(null);
  const [text, setText] = useState("");
  useEffect(() => {
    if (project) setOpenB((s) => (s.has(project) ? s : new Set(s).add(project)));
  }, [project]);
  const toggle = (name: string) =>
    setOpenB((s) => {
      const n = new Set(s);
      if (n.has(name)) n.delete(name);
      else n.add(name);
      return n;
    });
  const done = () => {
    const v = text.trim();
    if (v && adding?.kind === "building") p.onNewBuilding(v);
    if (v && adding?.kind === "floor") p.onNewFloor(adding.project, v);
    setText("");
    setAdding(null);
  };
  const field = (placeholder: string) => (
    <input
      className="sb-new"
      autoFocus
      value={text}
      maxLength={60}
      placeholder={placeholder}
      aria-label={placeholder}
      onChange={(e) => setText(e.target.value)}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Enter") done();
        if (e.key === "Escape") {
          setText("");
          setAdding(null);
        }
      }}
      onBlur={done}
    />
  );
  const item = (id: ListId, text: string, icon: ReactElement, count?: number, tone?: string) => {
    const on = !p.inSettings && p.list === id;
    return (
      <button
        key={id}
        type="button"
        className={on ? "sb-item on" : "sb-item"}
        aria-current={on ? "page" : undefined}
        onClick={() => p.onList(id)}
      >
        <span className={`sb-icon ${tone ?? ""}`} aria-hidden>
          {icon}
        </span>
        <span className="sb-text">{text}</span>
        {count !== undefined && count > 0 && <span className="sb-count">{count}</span>}
      </button>
    );
  };
  return (
    <aside className="sidebar" aria-label="Lists">
      <div className="sb-top" data-tauri-drag-region>
        {p.lights}
        <span className="sb-brand" data-tauri-drag-region>
          Plucky
        </span>
      </div>
      <button type="button" className="sb-search" onClick={p.onSearch} title="Search (/ or ⌘K)">
        <SearchIcon />
        <span>Search</span>
        <kbd>⌘K</kbd>
      </button>
      <nav className="sb-nav" aria-label="Lists">
        {item("today", "Today", <StarIcon />, p.counts.today, "t-today")}
        {item("upcoming", "Calendar", <CalIcon />, undefined, "t-upcoming")}
        {item("all", "Anytime", <LinesIcon />, p.counts.all, "t-anytime")}
        {item("someday", "Someday", <CloudIcon />, p.counts.someday, "t-someday")}
        {item("logbook", "Logbook", <LogIcon />, undefined, "t-logbook")}
      </nav>

      <div className="sb-scroll">
        <h2 className="sb-head sb-head-row">
          {w.projects}
          <button type="button" className="sb-add" onClick={() => setAdding({ kind: "building" })} aria-label={`New ${w.project.toLowerCase()}`} title={`New ${w.project.toLowerCase()}`}>
            +
          </button>
        </h2>
        {adding?.kind === "building" && field(`New ${w.project.toLowerCase()}'s name`)}
        {p.buildings.length === 0 && !adding && (
          <p className="sb-empty">
            Press + to put up your first {w.project.toLowerCase()}, or type “@Name” in a {w.task}.
          </p>
        )}
        {p.buildings.map((b) => {
          const name = b.project!;
          const on = !p.inSettings && project === name && !(p.floorOn && p.floorOn.project === name);
          const expanded = openB.has(name);
          const pr = p.projects.find((x) => x.name === name);
          return (
            <div key={name} className="sb-building">
              <div className={on ? "sb-item sb-b on" : "sb-item sb-b"}>
                <button
                  type="button"
                  className={expanded ? "sb-chev open" : "sb-chev"}
                  onClick={() => toggle(name)}
                  aria-label={expanded ? `Hide ${name}'s floors` : `Show ${name}'s floors`}
                  aria-expanded={expanded}
                >
                  <svg width="9" height="9" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2.4" aria-hidden>
                    <path d="M6 3.5 10.5 8 6 12.5" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                </button>
                <button type="button" className="sb-b-main" aria-current={on ? "page" : undefined} onClick={() => p.onList(projectList(name))}>
                  <span className="sb-icon t-project" aria-hidden>
                    <Pie done={pr?.done ?? b.done} total={(pr?.open ?? b.open) + (pr?.done ?? b.done)} />
                  </span>
                  <span className="sb-text">{name}</span>
                  {b.open > 0 && <span className="sb-count">{b.open}</span>}
                </button>
              </div>
              {expanded && (
                <div className="sb-floors">
                  {[...b.floors].reverse().map((f) => (
                    <button
                      key={f.label}
                      type="button"
                      className={p.floorOn && p.floorOn.project === name && p.floorOn.floor === f.name ? "sb-floor on" : "sb-floor"}
                      aria-current={p.floorOn && p.floorOn.project === name && p.floorOn.floor === f.name ? "page" : undefined}
                      onClick={() => p.onFloor(name, f.name)} title={f.name ? f.label : "Rooms not on a floor yet"}>
                      <span className="sb-floor-name">{f.label}</span>
                      <span className="sb-floor-count" title={`${f.rooms.filter((r) => !r.lit).length} dark · ${f.rooms.filter((r) => r.lit).length} lit`}>
                        {f.rooms.filter((r) => !r.lit).length || ""}
                      </span>
                    </button>
                  ))}
                  {adding?.kind === "floor" && adding.project === name ? (
                    field(`New ${w.heading.toLowerCase()}'s name`)
                  ) : (
                    <button type="button" className="sb-floor sb-floor-add" onClick={() => setAdding({ kind: "floor", project: name })}>
                      {w.newHeading}
                    </button>
                  )}
                </div>
              )}
            </div>
          );
        })}

        {p.tags.length > 0 && (
          <>
            <h2 className="sb-head">Tags</h2>
            <div className="sb-tags">
              {p.tags.map((t) => (
                <button
                  key={t}
                  type="button"
                  className={p.activeTags.includes(t) ? "sb-tag on" : "sb-tag"}
                  aria-pressed={p.activeTags.includes(t)}
                  onClick={() => p.onTag(t)}
                >
                  {t}
                </button>
              ))}
            </div>
          </>
        )}
      </div>

      <div className="sb-foot">
        <div className="sb-local">
          <span className="sb-local-title">
            <span className="local-dot" aria-hidden /> On this Mac
          </span>
          <span className="sb-local-text">
            {p.model ? `${p.model} · ` : ""}
            {p.captureHint}
          </span>
        </div>
        <button type="button" className="sb-mayor" onClick={p.onCity} title="Open your city">
          <span className="mayor-badge" aria-hidden>
            {initials(p.mayor)}
          </span>
          <span className="sb-mayor-text">
            <span className="sb-mayor-title">{p.mayor ? `Mayor ${p.mayor}` : "The mayor"}</span>
            <span className="sb-mayor-sub">
              {p.cityName ?? "Name your city"} · {p.lit} {p.lit === 1 ? "room" : "rooms"} lit
            </span>
          </span>
        </button>
        <div className="sb-foot-row">
          <button type="button" className={p.inSettings ? "sb-item on" : "sb-item"} onClick={p.onSettings} title="Settings (⌘,)">
            <span className="sb-icon" aria-hidden>
              <GearIcon />
            </span>
            <span className="sb-text">Settings</span>
            {p.updateReady && <span className="sb-dot" aria-label="Update ready" />}
          </button>
          <button type="button" className="sb-keys" onClick={p.onKeys} title="Keyboard shortcuts (?)" aria-label="Keyboard shortcuts">
            ?
          </button>
        </div>
      </div>
    </aside>
  );
}
