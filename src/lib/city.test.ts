import { describe, expect, it } from "vitest";
import { buildCity, cityStats, floorShape, heightOf, initials, lots, MAIN_STREET, ordinal, roomSpot } from "./city";
import type { CityWindow, Task } from "./types";

let id = 0;
const win = (project: string | null, completed_at: string, heading: string | null = null, title = "t"): CityWindow => ({
  id: ++id,
  title,
  project,
  heading,
  completed_at,
});
const open = (project: string | null, extra: Partial<Task> = {}): Task =>
  ({
    id: ++id,
    title: "open",
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
    project,
    heading: null,
    checklist: [],
    series_date: null,
    paused: false,
    ...extra,
  }) as Task;

describe("the city", () => {
  it("puts lots in a spiral from the middle, each once", () => {
    const l = lots(9);
    expect(l[0]).toEqual([0, 0]);
    expect(new Set(l.map((p) => p.join())).size).toBe(9);
    expect(l.every(([x, y]) => Math.abs(x) <= 1 && Math.abs(y) <= 1)).toBe(true);
  });

  it("names floors 1st, 2nd, 3rd…", () => {
    expect([1, 2, 3, 4, 11, 12, 13, 21, 22].map(ordinal)).toEqual(["1st", "2nd", "3rd", "4th", "11th", "12th", "13th", "21st", "22nd"]);
  });

  it("makes floors wider with more rooms, and taller past a point", () => {
    expect(floorShape(2).per).toBe(1);
    expect(floorShape(20).per).toBe(4);
    expect(floorShape(20).size).toBeGreaterThan(floorShape(4).size);
    expect(floorShape(200).levels).toBeGreaterThan(1);
  });

  it("puts rooms round each storey, side by side", () => {
    const f = { name: "A", label: "", rooms: [], ...floorShape(18) };
    expect(roomSpot(f, 0)).toEqual({ level: 0, side: 0, slot: 0 });
    expect(roomSpot(f, 4)).toEqual({ level: 0, side: 1, slot: 1 });
  });

  it("stacks floors by size, lobby first, never wider going up", () => {
    const city = buildCity(
      [win("B", "2026-10-02T10:00:00Z", "Small"), win("B", "2026-10-03T10:00:00Z", "Big"), win("B", "2026-10-04T10:00:00Z", "Big")],
      [open("B", { heading: "Big" }), open("B", { heading: "Big" }), open("B"), open("C", { someday: true })],
      [{ name: "D", open: 0, done: 0 }],
      [{ project: "B", name: "Empty", open: 0, done: 0 }],
    );
    expect(city.buildings.map((b) => b.name)).toEqual([MAIN_STREET, "B", "C", "D"]);
    const b = city.buildings[1];
    expect(b.floors.map((f) => f.label)).toEqual(["Lobby", "1st Floor: Big", "2nd Floor: Small", "3rd Floor: Empty"]);
    expect(b.floors[1].rooms.map((r) => r.lit)).toEqual([true, true, false, false]);
    for (let i = 1; i < b.floors.length; i++) expect(b.floors[i].size).toBeLessThanOrEqual(b.floors[i - 1].size);
    expect(b.open).toBe(3);
    expect(b.done).toBe(3);
    expect(city.buildings[2].building).toBe(true);
    expect(city.buildings[3].planned).toBe(true);
    expect(heightOf(b)).toBeGreaterThan(heightOf(city.buildings[3]));
  });

  it("puts today's timed rooms on the building's billboard, in time order", () => {
    const city = buildCity([], [open("A", { due_date: "2026-10-24", due_time: "15:00", title: "b" }), open("A", { due_date: "2026-10-24", due_time: "09:30", title: "a" })], [], [], "2026-10-24");
    expect(city.buildings[1].today).toEqual([
      { time: "09:30", title: "a" },
      { time: "15:00", title: "b" },
    ]);
  });

  it("counts the week, today and the week before", () => {
    const now = new Date(2026, 9, 24, 15, 0);
    const iso = (d: number, h = 12) => new Date(2026, 9, d, h).toISOString();
    const city = buildCity([win("A", iso(24)), win("A", iso(22)), win("A", iso(14)), win(null, iso(1))], [open("A")]);
    const s = cityStats(city, "week", now, "en-US");
    expect(s.inRange).toBe(2);
    expect(s.today).toBe(1);
    expect(s.before).toBe(1);
    expect(s.open).toBe(1);
    expect(cityStats(city, "all", now).inRange).toBe(4);
  });

  it("makes the mayor's initials", () => {
    expect(initials("Sam Rivera")).toBe("SR");
    expect(initials("maya")).toBe("M");
    expect(initials(null)).toBe("M");
  });
});
