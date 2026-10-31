import { describe, expect, it } from "vitest";
import {
  continueNote,
  defaultAgent,
  folderFor,
  monogram,
  PANEL_PROMPTS,
  rememberFolder,
  runsByTask,
  runText,
  shortFolder,
} from "./agentRuns";
import type { AgentRun } from "./types";

function run(id: number, task_id: number, status: AgentRun["status"] = "working"): AgentRun {
  return {
    id,
    task_id,
    agent: "claude",
    agent_name: "Claude Code",
    folder: "/Users/sam/Projects/site",
    status,
    summary: null,
    links: [],
    started_at: "2026-10-30T19:00:00Z",
    updated_at: "2026-10-30T19:05:00Z",
    session: 1,
  };
}

describe("agent runs", () => {
  it("says where a run is, in plain words", () => {
    expect(runText(run(1, 1, "working")).label).toBe("Claude Code is working");
    expect(runText(run(1, 1, "needs_you")).label).toBe("Claude Code needs you");
    expect(runText(run(1, 1, "ready"))).toEqual({ label: "Ready to review", tone: "ready" });
    expect(runText(run(1, 1, "paused")).label).toBe("Claude Code paused");
    expect(runText({ status: "working", agent_name: "" }).label).toBe("The agent is working");
  });

  it("keeps each task's newest run", () => {
    const m = runsByTask([run(2, 7), run(5, 7, "ready"), run(3, 8)]);
    expect(m.get(7)?.id).toBe(5);
    expect(m.get(8)?.id).toBe(3);
    expect(m.size).toBe(2);
  });

  it("gives each agent its own tile", () => {
    const tiles = ["claude", "codex", "gemini", "cursor"].map((a) => monogram(a).letters);
    expect(new Set(tiles).size).toBe(4);
    expect(monogram(null).letters).toBe("");
  });

  it("writes the home folder as ~", () => {
    expect(shortFolder("/Users/sam/Projects/site", "/Users/sam")).toBe("~/Projects/site");
    expect(shortFolder("/Users/sam", "/Users/sam/")).toBe("~");
    expect(shortFolder("/Users/samuel/x", "/Users/sam")).toBe("/Users/samuel/x");
    expect(shortFolder("/tmp", "")).toBe("/tmp");
  });

  it("remembers a folder per project", () => {
    let mem = { byProject: {} };
    expect(folderFor(mem, "Website", "/Users/sam")).toBe("/Users/sam");
    mem = rememberFolder(mem, "Website", "/Users/sam/Projects/site");
    expect(folderFor(mem, "Website", "/Users/sam")).toBe("/Users/sam/Projects/site");
    // Another project starts where you last worked.
    expect(folderFor(mem, "Launch", "/Users/sam")).toBe("/Users/sam/Projects/site");
    mem = rememberFolder(mem, null, "/Users/sam/Notes");
    expect(folderFor(mem, "Website", "/Users/sam")).toBe("/Users/sam/Projects/site");
    expect(folderFor(mem, null, "/Users/sam")).toBe("/Users/sam/Notes");
  });

  it("offers the last agent used if it's still installed", () => {
    expect(defaultAgent(["claude", "codex"], "codex")).toBe("codex");
    expect(defaultAgent(["claude"], "codex")).toBe("claude");
    expect(defaultAgent([], "codex")).toBeNull();
  });

  it("continues with what the agent last said", () => {
    expect(continueNote({ summary: null })).toBe("Pick up where you left off.");
    expect(continueNote({ summary: " Tests pass; PR next. " })).toContain("Tests pass; PR next.");
  });

  it("ready-made requests ask before changing anything", () => {
    for (const p of PANEL_PROMPTS) {
      expect(p.text).toMatch(/TodoCity/);
      expect(p.text).toMatch(/say yes|Ask before/);
    }
  });
});
