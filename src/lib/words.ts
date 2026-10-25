import { createContext, useContext } from "react";

/**
 * What things are called. The side panel uses plain words; full screen adds
 * the city's: a project's sections are floors. (The city itself tells the
 * Lights On story: projects are buildings, tasks are homes.)
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
  /** A task's checklist item: "sub-task" (lower case). */
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
  step: "sub-task",
  steps: "sub-tasks",
  inProject: (p) => `in ${p}`,
  progress: (o, d) => `${o} open · ${d} done`,
  toDo: (k) => `${k} to do`,
  open: (k) => `${k} open`,
  looseHeading: "Tasks",
  emptyProject: (p) => `No tasks in ${p}`,
};

/**
 * Full screen: plain words for the work (task, sub-task, project), with the
 * city's names where they help you picture it — a project's sections are its
 * floors, and tasks on no floor are on the ground floor.
 */
export const CITY: Words = {
  city: true,
  project: "Project",
  projects: "Projects",
  newProject: "+ New project",
  newProjectName: "New project's name",
  noProject: "No project",
  heading: "Floor",
  newHeading: "+ Floor",
  headingIn: (p) => `Floor in ${p}`,
  task: "task",
  tasks: "tasks",
  newTask: "New task",
  addButton: "Add Task",
  step: "sub-task",
  steps: "sub-tasks",
  inProject: (p) => `in ${p}`,
  progress: (o, d) => `${o} to do · ${d} done`,
  toDo: (k) => `${k} to do`,
  open: (k) => `${k} open`,
  looseHeading: "Ground floor",
  emptyProject: (p) => `No tasks in ${p} yet`,
};

export const WordsContext = createContext<Words>(PLAIN);
export const useWords = () => useContext(WordsContext);
