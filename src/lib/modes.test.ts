import { describe, expect, it } from "vitest";
import { activeMode, modeSummary, newMode, setNewProjects, setProjectShown, showsProject, showsTask } from "./modes";
import type { AppSettings, ViewMode } from "./types";

const work: ViewMode = {
  id: "work",
  name: "Work",
  icon: "💼",
  projects: ["Q4 launch"],
  new_projects: false,
  no_project: true,
  hidden_calendars: [],
  notify: true,
  new_task_project: null,
};
const personal: ViewMode = { ...work, id: "personal", name: "Personal", projects: ["Q4 launch"], new_projects: true };

describe("modes", () => {
  it("show the projects they list, or all but those", () => {
    expect(showsProject(work, "Q4 launch")).toBe(true);
    expect(showsProject(work, "Home")).toBe(false);
    expect(showsProject(work, null)).toBe(true);
    expect(showsProject(personal, "Q4 launch")).toBe(false);
    expect(showsProject(personal, "Anything new")).toBe(true);
    expect(showsTask(null, { project: "Home" })).toBe(true);
  });

  it("tick and untick either way round", () => {
    expect(setProjectShown(work, "Home", true).projects).toEqual(["Home", "Q4 launch"]);
    expect(setProjectShown(work, "Q4 launch", false).projects).toEqual([]);
    expect(setProjectShown(personal, "Q4 launch", true).projects).toEqual([]);
    expect(setProjectShown(personal, "Home", false).projects).toEqual(["Home", "Q4 launch"]);
  });

  it("keep what's shown when new projects are switched on or off", () => {
    const all = ["Home", "Q4 launch", "Hiring"];
    const flipped = setNewProjects(work, true, all);
    expect(all.filter((p) => showsProject(flipped, p))).toEqual(["Q4 launch"]);
    expect(showsProject(flipped, "Later")).toBe(true);
    const back = setNewProjects(flipped, false, all);
    expect(back.projects).toEqual(["Q4 launch"]);
  });

  it("find the active one and describe it", () => {
    const s = { modes: [work, personal], mode: "work" } as unknown as AppSettings;
    expect(activeMode(s)?.name).toBe("Work");
    expect(activeMode({ ...s, mode: null })).toBeNull();
    expect(activeMode({ ...s, mode: "gone" })).toBeNull();
    expect(modeSummary(work, ["Q4 launch", "Home"])).toBe("Q4 launch");
    expect(modeSummary(personal, ["Home", "Hiring"])).toBe("All projects");
    expect(newMode([work, personal]).id).toBe("mode-3");
  });
});
