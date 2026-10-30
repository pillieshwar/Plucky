import { describe, expect, it } from "vitest";
import { byGroup } from "./CalendarSyncSection";

describe("calendar lanes by group", () => {
  it("keeps groups in order, projects under them", () => {
    const lane = (group: string, name: string, on = true) => ({ key: `p:${name}`, group, name, on });
    const g = byGroup([lane("Work", "Launch"), lane("Work", "Hiring", false), lane("Personal", "Home"), lane("Personal", "Inbox")]);
    expect(g.map((x) => x.group)).toEqual(["Work", "Personal"]);
    expect(g[0].lanes.map((l) => l.name)).toEqual(["Launch", "Hiring"]);
    expect(g[1].lanes).toHaveLength(2);
  });
});
