import type { AppSettings, Task, ViewMode } from "./types";

/** The mode this Mac is in, or null (everything shown). */
export function activeMode(settings: AppSettings | null | undefined): ViewMode | null {
  const id = settings?.mode;
  if (!id) return null;
  return settings?.modes?.find((m) => m.id === id) ?? null;
}

/** Whether a mode shows tasks in `project` (null: no project). */
export function showsProject(mode: ViewMode, project: string | null | undefined): boolean {
  if (!project) return mode.no_project;
  return mode.projects.includes(project) !== mode.new_projects;
}

export function showsTask(mode: ViewMode | null, task: Pick<Task, "project">): boolean {
  return !mode || showsProject(mode, task.project);
}

/** Tick or untick a project in a mode (whichever way the mode stores it). */
export function setProjectShown(mode: ViewMode, project: string, shown: boolean): ViewMode {
  const listed = shown !== mode.new_projects;
  const rest = mode.projects.filter((p) => p !== project);
  return { ...mode, projects: listed ? [...rest, project].sort((a, b) => a.localeCompare(b)) : rest };
}

/**
 * Switch "show new projects here too" without changing what's shown now:
 * the list flips between shown and hidden projects.
 */
export function setNewProjects(mode: ViewMode, on: boolean, all: string[]): ViewMode {
  if (mode.new_projects === on) return mode;
  const shown = all.filter((p) => showsProject(mode, p));
  return { ...mode, new_projects: on, projects: on ? all.filter((p) => !shown.includes(p)) : shown };
}

/** A new, empty mode with an id not used yet. */
export function newMode(existing: ViewMode[], name = "New mode"): ViewMode {
  let n = existing.length + 1;
  while (existing.some((m) => m.id === `mode-${n}`)) n++;
  return {
    id: `mode-${n}`,
    name,
    icon: "◎",
    projects: [],
    new_projects: false,
    no_project: true,
    hidden_calendars: [],
    notify: true,
    new_task_project: null,
  };
}

/** A short line for a mode's projects: "Work, Q4 launch +2". */
export function modeSummary(mode: ViewMode, all: string[]): string {
  const shown = all.filter((p) => showsProject(mode, p));
  if (mode.new_projects && shown.length === all.length) return "All projects";
  if (!shown.length) return mode.no_project ? "Only tasks with no project" : "Nothing yet";
  const head = shown.slice(0, 2).join(", ");
  return shown.length > 2 ? `${head} +${shown.length - 2}` : head;
}
