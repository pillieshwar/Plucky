import { useWords } from "../lib/words";
import type { ReactElement } from "react";
import { projectList, projectOf, type ListId } from "../lib/lists";
import type { ProjectSummary } from "../lib/types";
import { CalIcon, CloudIcon, LinesIcon, LogIcon, Pie, StarIcon } from "./ListPicker";
import { GearIcon, SearchIcon } from "./icons";
import { BuildingIcon } from "./City";

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
  updateReady: boolean;
  model: string | null;
  captureHint: ReactElement;
  /** The window's close, minimize and zoom buttons. */
  lights: ReactElement;
}

/**
 * Full screen's sidebar: search, the lists (Today, Upcoming, Anytime,
 * Someday, Logbook), projects with their progress, tags, and — at the
 * bottom — what's reading captures and Settings.
 */
export function Sidebar(p: Props) {
  const w = useWords();
  const project = projectOf(p.list);
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
        {item("upcoming", "Upcoming", <CalIcon />, undefined, "t-upcoming")}
        {item("all", "Anytime", <LinesIcon />, p.counts.all, "t-anytime")}
        {item("someday", "Someday", <CloudIcon />, p.counts.someday, "t-someday")}
        {item("logbook", "Logbook", <LogIcon />, undefined, "t-logbook")}
      </nav>

      <div className="sb-scroll">
        <h2 className="sb-head">{w.projects}</h2>
        {p.projects.length === 0 && (
          <p className="sb-empty">
            Type “@Name” in a {w.task}, or open one and pick {w.project}.
          </p>
        )}
        {p.projects.map((pr) => {
          const on = !p.inSettings && project === pr.name;
          return (
            <button
              key={pr.name}
              type="button"
              className={on ? "sb-item on" : "sb-item"}
              aria-current={on ? "page" : undefined}
              onClick={() => p.onList(projectList(pr.name))}
            >
              <span className="sb-icon t-project" aria-hidden>
                <Pie done={pr.done} total={pr.open + pr.done} />
              </span>
              <span className="sb-text">{pr.name}</span>
              {pr.open > 0 && <span className="sb-count">{pr.open}</span>}
            </button>
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
        <button type="button" className="sb-item sb-city" onClick={p.onCity} title="Your city: every finished task lights a window">
          <span className="sb-icon" aria-hidden>
            <BuildingIcon />
          </span>
          <span className="sb-text">{p.cityName ?? "Your city"}</span>
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
