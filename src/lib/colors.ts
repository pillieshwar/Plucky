import { createContext, useContext } from "react";

/** Colors a project can have (Sidebar → ⋯ → Color). */
export const PROJECT_COLORS: [string, string][] = [
  ["#8b7dff", "Violet"],
  ["#4f8ff7", "Blue"],
  ["#2fb8c9", "Teal"],
  ["#3fbf7f", "Green"],
  ["#e5b23b", "Yellow"],
  ["#f08a3c", "Orange"],
  ["#ef5a5a", "Red"],
  ["#e463a6", "Pink"],
];

/** Each project's color, by name (only the ones the user picked). */
export const ProjectColors = createContext<Record<string, string>>({});

/** The color of a task's project, or undefined for the accent color. */
export function useProjectColor(project: string | null | undefined): string | undefined {
  const colors = useContext(ProjectColors);
  return project ? colors[project] : undefined;
}

export const useProjectColors = () => useContext(ProjectColors);
