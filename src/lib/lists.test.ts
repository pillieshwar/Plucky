import { describe, expect, it } from "vitest";
import { bulletSteps, effectiveDay, groupByHeading, isDeadlinePhrase, linesToSteps, tasksForList } from "./lists";
import { groupTasks } from "./grouping";
import { atProject } from "../components/AddTaskForm";
import type { Task } from "./types";

const TODAY = "2026-10-23";
let id = 0;
const task = (title: string, extra: Partial<Task> = {}): Task => ({
  id: ++id,
  title,
  due_date: null,
  due_time: null,
  recurrence: null,
  source_text: null,
  source_app: null,
  source_bundle: null,
  source_url: null,
  done: false,
  created_at: `2026-10-01T0${id % 10}:00:00Z`,
  created_tz: null,
  completed_at: null,
  snoozed_until: null,
  notified_at: null,
  next_id: null,
  notes: null,
  deadline: null,
  evening: false,
  someday: false,
  project: null,
  heading: null,
  checklist: [],
  series_date: null,
  paused: false,
  ...extra,
});

describe("deadlines", () => {
  it("pull a later-planned task to the deadline once it comes", () => {
    expect(effectiveDay(task("a", { due_date: "2026-10-30", deadline: TODAY }), TODAY)).toBe(TODAY);
    expect(effectiveDay(task("b", { due_date: "2026-10-30", deadline: "2026-10-25" }), TODAY)).toBe("2026-10-30");
    expect(effectiveDay(task("c", { deadline: "2026-10-20" }), TODAY)).toBe("2026-10-20");
  });

  it("are read from 'by …' phrases", () => {
    expect(isDeadlinePhrase("by Friday")).toBe(true);
    expect(isDeadlinePhrase("before 5pm")).toBe(true);
    expect(isDeadlinePhrase("on Friday")).toBe(false);
    expect(isDeadlinePhrase(null)).toBe(false);
  });
});

describe("lists", () => {
  const all = [
    task("today", { due_date: TODAY }),
    task("parked", { someday: true }),
    task("paused", { due_date: TODAY, recurrence: "daily", paused: true }),
    task("later", { due_date: "2026-10-28" }),
    task("in project", { project: "Offsite", heading: "Travel" }),
  ];
  it("keeps Someday and paused out of All and Today", () => {
    expect(tasksForList(all, "all", TODAY).map((t) => t.title)).toEqual(["today", "later", "in project"]);
    expect(tasksForList(all, "today", TODAY).map((t) => t.title)).toEqual(["today"]);
    expect(tasksForList(all, "someday", TODAY).map((t) => t.title)).toEqual(["parked", "paused"]);
    expect(tasksForList(all, "project:Offsite", TODAY).map((t) => t.title)).toEqual(["in project"]);
  });

  it("splits today into now and This Evening", () => {
    const groups = groupTasks(
      [task("now", { due_date: TODAY }), task("after work", { due_date: TODAY, evening: true })],
      new Date(2026, 9, 23, 10),
      "en-US",
    );
    expect(groups.map((g) => g.label)).toEqual(["Today", "This Evening"]);
  });

  it("groups a project by heading", () => {
    const g = groupByHeading([
      task("loose", { project: "P" }),
      task("fly", { project: "P", heading: "Travel" }),
      task("talk", { project: "P", heading: "Program" }),
      task("done", { project: "P", done: true, completed_at: "2026-10-22T10:00:00Z" }),
    ]);
    expect(g.map((x) => x.label)).toEqual(["Tasks", "Travel", "Program", "Done"]);
  });
});

describe("steps", () => {
  it("turn pasted lines into steps", () => {
    expect(linesToSteps("- milk\n• eggs\n\n1. bread\n[ ] butter")).toEqual(["milk", "eggs", "bread", "butter"]);
  });

  it("are offered from a bulleted selection", () => {
    expect(bulletSteps("Before Friday:\n- book room\n- order food\nThanks!")).toEqual(["book room", "order food"]);
    expect(bulletSteps("Just one line - with a dash")).toEqual([]);
  });
});

describe("@project in a new task", () => {
  it("matches an existing project by its start", () => {
    expect(atProject("Book hotel @off fri", ["Offsite 2026", "Home"])).toEqual({ project: "Offsite 2026", rest: "Book hotel fri" });
    expect(atProject("Book hotel @Offsite 2026 fri", ["Offsite 2026"])).toEqual({ project: "Offsite 2026", rest: "Book hotel fri" });
  });
  it("starts a new project from one word", () => {
    expect(atProject("Paint the fence @Garden sat", [])).toEqual({ project: "Garden", rest: "Paint the fence sat" });
  });
  it("leaves emails alone", () => {
    expect(atProject("Email sam@example.com", []).project).toBeNull();
  });
});
