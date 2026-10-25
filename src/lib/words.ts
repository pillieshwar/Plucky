import { createContext, useContext } from "react";

/**
 * What things are called. The side panel uses plain words; full screen tells
 * the city story: a project is a building, its headings are floors, each
 * task is a room — and finishing one lights its window. A task's steps are
 * the drawers in its room.
 */
export interface Words {
  city: boolean;
  project: string;
  projects: string;
  newProject: string;
  newProjectName: string;
  noProject: string;
  heading: string;
  newHeading: string;
  headingIn: (project: string) => string;
  /** "task" / "room" (lower case, singular). */
  task: string;
  tasks: string;
  newTask: string;
  /** The add button at the top of a list. */
  addButton: string;
  /** A task's checklist item: "step" / "drawer" (lower case). */
  step: string;
  steps: string;
  inProject: (project: string) => string;
  /** "3 open · 2 done" / "3 rooms open · 2 lit". */
  progress: (open: number, done: number) => string;
  toDo: (n: number) => string;
  open: (n: number) => string;
  /** The tasks in a project that are under no heading. */
  looseHeading: string;
  emptyProject: (project: string) => string;
}

const n = (k: number, one: string, many: string) => `${k} ${k === 1 ? one : many}`;

export const PLAIN: Words = {
  city: false,
  project: "Project",
  projects: "Projects",
  newProject: "+ New project",
  newProjectName: "New project name",
  noProject: "No project",
  heading: "Heading",
  newHeading: "+ Heading",
  headingIn: (p) => `Heading in ${p}`,
  task: "task",
  tasks: "tasks",
  newTask: "New task",
  addButton: "New task",
  step: "step",
  steps: "steps",
  inProject: (p) => `in ${p}`,
  progress: (o, d) => `${o} open · ${d} done`,
  toDo: (k) => `${k} to do`,
  open: (k) => `${k} open`,
  looseHeading: "Tasks",
  emptyProject: (p) => `No tasks in ${p}`,
};

export const CITY: Words = {
  city: true,
  project: "Building",
  projects: "Buildings",
  newProject: "+ New building",
  newProjectName: "New building's name",
  noProject: "Main Street",
  heading: "Floor",
  newHeading: "+ Floor",
  headingIn: (p) => `Floor in ${p}`,
  task: "room",
  tasks: "rooms",
  newTask: "New room",
  addButton: "Add Task (aka Room)",
  step: "drawer",
  steps: "drawers",
  inProject: (p) => `in the ${p} building`,
  progress: (o, d) => `${n(o, "room", "rooms")} open · ${d} lit`,
  toDo: (k) => `${n(k, "room", "rooms")} to do`,
  open: (k) => `${n(k, "open room", "open rooms")}`,
  looseHeading: "Lobby",
  emptyProject: (p) => `No rooms in ${p} yet`,
};

export const WordsContext = createContext<Words>(PLAIN);
export const useWords = () => useContext(WordsContext);
