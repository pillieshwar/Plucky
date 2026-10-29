import { describe, expect, it } from "vitest";
import { canOpenSource, linkParts, matchesQuery, sourceKind, sourceLabel, sourceTooltip, tagsOf, titleParts, topTags } from "./taskText";
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

describe("linkParts", () => {
  it("finds links and leaves trailing punctuation out", () => {
    expect(linkParts("Form: https://example.com/a?b=1. Ask Sam")).toEqual([
      { text: "Form: ", url: null },
      { text: "https://example.com/a?b=1", url: "https://example.com/a?b=1" },
      { text: ". Ask Sam", url: null },
    ]);
    expect(linkParts("mail mailto:sam@example.com")[1].url).toBe("mailto:sam@example.com");
    expect(linkParts("no links here")).toEqual([{ text: "no links here", url: null }]);
  });

  it("searches descriptions too", () => {
    expect(matchesQuery(task("Pay rent", { notes: "portal at bank.example" }), "portal")).toBe(true);
  });
});

describe("source chip", () => {
  const src = (source_app: string | null, source_bundle: string | null, source_url: string | null) => ({ source_app, source_bundle, source_url });
  it("picks an icon for where a task came from", () => {
    expect(sourceKind(src("Mail", "com.apple.mail", null))).toBe("mail");
    expect(sourceKind(src("Microsoft Outlook", "com.microsoft.Outlook", null))).toBe("mail");
    expect(sourceKind(src("Slack", "com.tinyspeck.slackmacgap", "https://app.slack.com/client/T1/C2"))).toBe("chat");
    expect(sourceKind(src("Google Chrome", "com.google.Chrome", "https://example.com/a"))).toBe("web");
    expect(sourceKind(src("Preview", "com.apple.Preview", "file:///Users/sam/Plan.pdf"))).toBe("doc");
    expect(sourceKind(src("Notes", "com.apple.Notes", null))).toBe("app");
  });
  it("opens the exact thing when there's a link, or else the app", () => {
    expect(sourceTooltip(src("Slack", "com.tinyspeck.slackmacgap", "https://app.slack.com/client/T1/C2"))).toBe("Open the message in Slack");
    expect(sourceTooltip(src("Safari", "com.apple.Safari", "https://www.example.com/a"))).toBe("Open example.com");
    expect(sourceTooltip(src("Preview", "com.apple.Preview", "file:///Users/sam/Q3%20plan.pdf"))).toBe("Open Q3 plan.pdf");
    expect(sourceTooltip(src("Microsoft Outlook", "com.microsoft.Outlook", null))).toBe("Opens Microsoft Outlook");
  });
  it("is plain text when there's nothing to open", () => {
    expect(canOpenSource(src("Notes", null, null))).toBe(false);
    expect(sourceTooltip(src("Notes", null, null))).toBeNull();
    expect(canOpenSource(src(null, null, "javascript:alert(1)"))).toBe(false);
    expect(canOpenSource(src("Notes", "com.apple.Notes", null))).toBe(true);
  });
});
