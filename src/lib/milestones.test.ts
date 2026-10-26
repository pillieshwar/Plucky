import { describe, expect, it } from "vitest";
import { MILESTONES, cheerFor, isUnlocked, newMilestones, nextMilestone, reachedMilestones } from "./milestones";

describe("milestones", () => {
  it("are in order, from 10 to 1,000", () => {
    const at = MILESTONES.map((m) => m.at);
    expect(at).toEqual([10, 25, 50, 100, 250, 500, 1000]);
  });

  it("unlock at their population", () => {
    expect(reachedMilestones(9)).toEqual([]);
    expect(reachedMilestones(10).map((m) => m.id)).toEqual(["lamps"]);
    expect(reachedMilestones(260).map((m) => m.id)).toEqual(["lamps", "park", "fountain", "train", "harbour"]);
    expect(isUnlocked("train", 99)).toBe(false);
    expect(isUnlocked("train", 100)).toBe(true);
  });

  it("show the way to the next one", () => {
    expect(nextMilestone(0)).toMatchObject({ left: 10, progress: 0 });
    const n = nextMilestone(75)!;
    expect(n.milestone.id).toBe("train");
    expect(n.left).toBe(25);
    expect(n.progress).toBeCloseTo(0.5);
    expect(nextMilestone(1000)).toBeNull();
  });

  it("celebrate only what's new, highest first", () => {
    expect(newMilestones(10, 24)).toEqual([]);
    expect(newMilestones(10, 50).map((m) => m.id)).toEqual(["park", "fountain"]);
    expect(cheerFor(newMilestones(0, 100))).toBe("Population 100 — the train is running! (4 milestones reached)");
    expect(cheerFor(newMilestones(50, 100))).toBe("Population 100 — the train is running!");
    expect(cheerFor([])).toBeNull();
  });
});
