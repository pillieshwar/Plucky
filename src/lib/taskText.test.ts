import { describe, expect, it } from "vitest";
import { matchesQuery, sourceLabel, tagsOf, titleParts, topTags } from "./taskText";
import type { Task } from "./types";

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
  created_at: "2026-10-01T00:00:00Z",
  created_tz: null,
  completed_at: null,
  snoozed_until: null,
  notified_at: null,
  next_id: null,
  ...extra,
});

describe("tags", () => {
  it("finds and splits tags", () => {
    expect(tagsOf("Pay rent #home #Home #bills")).toEqual(["#home", "#bills"]);
    expect(titleParts("Pay rent #home now")).toEqual([
      { text: "Pay rent ", tag: false },
      { text: "#home", tag: true },
      { text: " now", tag: false },
    ]);
    expect(tagsOf("Fix issue #12 in café #déjà-vu")).toEqual(["#12", "#déjà-vu"]);
  });

  it("ranks tags by use among open tasks", () => {
    const ts = [task("a #work"), task("b #work #home"), task("c #home"), task("d #work"), task("e #old", { done: true })];
    expect(topTags(ts)).toEqual(["#work", "#home"]);
  });
});

describe("matchesQuery", () => {
  const t = task("Send deck to Priya #work", { source_text: "Can you send the Q3 deck?", source_app: "Slack" });
  it("matches words anywhere and tags exactly", () => {
    expect(matchesQuery(t, "")).toBe(true);
    expect(matchesQuery(t, "priya q3")).toBe(true);
    expect(matchesQuery(t, "slack")).toBe(true);
    expect(matchesQuery(t, "#work")).toBe(true);
    expect(matchesQuery(t, "#wor")).toBe(false);
    expect(matchesQuery(t, "budget")).toBe(false);
  });
});

describe("sourceLabel", () => {
  it("prefers the site for browsers and the app otherwise", () => {
    expect(sourceLabel({ source_app: "Google Chrome", source_url: "https://www.github.com/x/y" })).toBe("github.com");
    expect(sourceLabel({ source_app: "Slack", source_url: "https://app.slack.com/client/T1/C2" })).toBe("Slack");
    expect(sourceLabel({ source_app: "Preview", source_url: "file:///Users/me/Q3%20plan.pdf" })).toBe("Q3 plan.pdf");
    expect(sourceLabel({ source_app: "Notes", source_url: null })).toBe("Notes");
    expect(sourceLabel({ source_app: null, source_url: null })).toBeNull();
  });
});
