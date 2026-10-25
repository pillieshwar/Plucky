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
  counts: { all: number; today: number; someday: number; overdue: number };
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
  /** The population: every finished task. */
  lit: number;
  /** The city's buildings (projects), with their floors stacked as drawn. */
  buildings: Building[];
  /** Open a building at one of its floors (null: the ground floor). */
  onFloor: (project: string, floor: string | null) => void;
  /** The floor whose page is showing. */
  floorOn: { project: string; floor: string | null } | null;
  onNewBuilding: (name: string) => void;
  onNewFloor: (project: string, name: string) => void;
  onRenameBuilding: (from: string, to: string) => void;
  /** Take down an empty building. */
  onDeleteBuilding: (name: string) => void;
  onRenameFloor: (project: string, from: string, to: string) => void;
  onDeleteFloor: (project: string, name: string) => void;
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
  const [adding, setAdding] = useState<
    | { kind: "building" }
    | { kind: "floor"; project: string }
    | { kind: "rename-building"; project: string }
    | { kind: "rename-floor"; project: string; floor: string }
    | null
  >(null);
  const [text, setText] = useState("");
  // The "⋯" menu open on a building or a floor.
  const [menu, setMenu] = useState<{ project: string; floor?: string } | null>(null);
  useEffect(() => {
    if (!menu) return;
    const close = (e: PointerEvent) => {
      if (!(e.target as HTMLElement).closest(".sb-menu, .sb-more")) setMenu(null);
    };
    document.addEventListener("pointerdown", close, true);
    return () => document.removeEventListener("pointerdown", close, true);
  }, [menu]);
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
    if (v && adding?.kind === "rename-building" && v !== adding.project) p.onRenameBuilding(adding.project, v);
    if (v && adding?.kind === "rename-floor" && v !== adding.floor) p.onRenameFloor(adding.project, adding.floor, v);
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
        {item("overdue", "Overdue", <OverdueIcon />, p.counts.overdue, p.counts.overdue ? "t-overdue" : "t-overdue quiet")}
        {item("logbook", "Logbook", <LogIcon />, undefined, "t-logbook")}
      </nav>

      <div className="sb-scroll">
        <h2 className="sb-head sb-head-row">
          <span>
            {w.projects} <span className="sb-head-aka">(Buildings)</span>
          </span>
          <button type="button" className="sb-add" onClick={() => setAdding({ kind: "building" })} aria-label="New project" title="New project (a new building)">
            +
          </button>
        </h2>
        {adding?.kind === "building" && field(`New ${w.project.toLowerCase()}'s name`)}
        {p.buildings.length === 0 && !adding && (
          <p className="sb-empty">
            Press + to start your first project — a new building in your city — or type “@Name” in a task.
          </p>
        )}
        {p.buildings.map((b) => {
          const name = b.project!;
          const on = !p.inSettings && project === name && !(p.floorOn && p.floorOn.project === name);
          const expanded = openB.has(name);
          const pr = p.projects.find((x) => x.name === name);
          const total = (pr?.open ?? b.open) + (pr?.done ?? b.done);
          if (adding?.kind === "rename-building" && adding.project === name) {
            return (
              <div key={name} className="sb-building">
                {field("Project's new name")}
              </div>
            );
          }
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
                <button
                  type="button"
                  className="sb-more"
                  aria-label={`More for ${name}`}
                  title="Rename or delete"
                  onClick={() => setMenu(menu && menu.project === name && !menu.floor ? null : { project: name })}
                >
                  ⋯
                </button>
                {menu && menu.project === name && !menu.floor && (
                  <div className="sb-menu" role="menu">
                    <button
                      type="button"
                      role="menuitem"
                      onClick={() => {
                        setMenu(null);
                        setText(name);
                        setAdding({ kind: "rename-building", project: name });
                      }}
                    >
                      Rename project…
                    </button>
                    <button
                      type="button"
                      role="menuitem"
                      onClick={() => {
                        setMenu(null);
                        setOpenB((s) => new Set(s).add(name));
                        setAdding({ kind: "floor", project: name });
                      }}
                    >
                      Add a floor…
                    </button>
                    <button
                      type="button"
                      role="menuitem"
                      className="danger"
                      disabled={total > 0}
                      title={total > 0 ? "Delete or move its tasks first — a building with homes can't be taken down" : undefined}
                      onClick={() => {
                        setMenu(null);
                        p.onDeleteBuilding(name);
                      }}
                    >
                      Delete project
                      {total > 0 && <span className="sb-menu-note">Only when it has no tasks</span>}
                    </button>
                  </div>
                )}
              </div>
              {expanded && (
                <div className="sb-floors">
                  {[...b.floors].reverse().map((f) => {
                    const fname = f.name;
                    if (fname && adding?.kind === "rename-floor" && adding.project === name && adding.floor === fname) {
                      return <div key={f.label}>{field("Floor's new name")}</div>;
                    }
                    const fOn = !!p.floorOn && p.floorOn.project === name && p.floorOn.floor === fname;
                    const todo = f.rooms.filter((r) => !r.lit).length;
                    return (
                      <div key={f.label} className={fOn ? "sb-floor-row on" : "sb-floor-row"}>
                        <button
                          type="button"
                          className={fOn ? "sb-floor on" : "sb-floor"}
                          aria-current={fOn ? "page" : undefined}
                          onClick={() => p.onFloor(name, fname)}
                          title={fname ? f.label : "Tasks in this project on no floor"}
                        >
                          <span className="sb-floor-name">{f.label}</span>
                          <span className="sb-floor-count" title={`${todo} to do · ${f.rooms.length - todo} done`}>
                            {todo || ""}
                          </span>
                        </button>
                        {fname && (
                          <button
                            type="button"
                            className="sb-more"
                            aria-label={`More for ${f.label}`}
                            title="Rename or delete"
                            onClick={() => setMenu(menu && menu.project === name && menu.floor === fname ? null : { project: name, floor: fname })}
                          >
                            ⋯
                          </button>
                        )}
                        {fname && menu && menu.project === name && menu.floor === fname && (
                          <div className="sb-menu" role="menu">
                            <button
                              type="button"
                              role="menuitem"
                              onClick={() => {
                                setMenu(null);
                                setText(fname);
                                setAdding({ kind: "rename-floor", project: name, floor: fname });
                              }}
                            >
                              Rename floor…
                            </button>
                            <button
                              type="button"
                              role="menuitem"
                              className="danger"
                              disabled={f.rooms.length > 0}
                              title={f.rooms.length > 0 ? "Delete or move its tasks first" : undefined}
                              onClick={() => {
                                setMenu(null);
                                p.onDeleteFloor(name, fname);
                              }}
                            >
                              Delete floor
                              {f.rooms.length > 0 && <span className="sb-menu-note">Only when it has no tasks</span>}
                            </button>
                          </div>
                        )}
                      </div>
                    );
                  })}
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
              {p.cityName ?? "Name your city"} · population {p.lit}
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

function OverdueIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <circle cx="8" cy="8.5" r="5.5" />
      <path d="M8 5.6v3.2l2 1.3M3 2.6 1.8 3.8M13 2.6l1.2 1.2" />
    </svg>
  );
}
