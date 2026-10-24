import { describe, expect, it } from "vitest";
import { buildCity, cityStats, inside, lots, MAIN_STREET, pick, shape, windowSpot } from "./city";
import type { CityWindow, Task } from "./types";

let id = 0;
const win = (project: string | null, completed_at: string, title = "t"): CityWindow => ({ id: ++id, title, project, completed_at });
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

  it("grows buildings wider and taller with more windows", () => {
    expect(shape(0).floors).toBe(1);
    expect(shape(10).per).toBe(2);
    expect(shape(200).per).toBeGreaterThan(shape(10).per);
    expect(shape(5000).floors).toBeLessThanOrEqual(72);
  });

  it("fills windows floor by floor, all round", () => {
    expect(windowSpot(0, 3)).toEqual({ floor: 1, side: 0, slot: 0 });
    expect(windowSpot(4, 3)).toEqual({ floor: 1, side: 1, slot: 1 });
    expect(windowSpot(12, 3)).toEqual({ floor: 2, side: 0, slot: 0 });
  });

  it("makes a building per project, Main Street first, oldest downtown", () => {
    const city = buildCity(
      [win("B", "2026-10-02T10:00:00Z"), win("A", "2026-10-05T10:00:00Z"), win(null, "2026-10-06T10:00:00Z"), win("B", "2026-10-07T10:00:00Z")],
      [open("A"), open("C", { someday: true }), { ...open("B"), done: true }],
    );
    expect(city.buildings.map((b) => b.name)).toEqual([MAIN_STREET, "B", "A", "C"]);
    expect(city.buildings[0].gx).toBe(0);
    const [, b, a, c] = city.buildings;
    expect(b.windows.length).toBe(2);
    expect(b.finished).toBe(true);
    expect(a.finished).toBe(false);
    expect(c.planned).toBe(true);
    expect(city.total).toBe(4);
    expect(city.founded).toBe("2026-10-02T10:00:00Z");
  });

  it("counts the week, today and the week before", () => {
    const now = new Date(2026, 9, 24, 15, 0);
    const iso = (d: number, h = 12) => new Date(2026, 9, d, h).toISOString();
    const city = buildCity([win("A", iso(24)), win("A", iso(22)), win("A", iso(14)), win(null, iso(1))], []);
    const s = cityStats(city, "week", now, "en-US");
    expect(s.inRange).toBe(2);
    expect(s.today).toBe(1);
    expect(s.before).toBe(1);
    expect(s.tallest?.name).toBe("A");
    expect(cityStats(city, "all", now).inRange).toBe(4);
  });

  it("finds what's under the pointer", () => {
    const sq: [number, number][] = [
      [0, 0],
      [10, 0],
      [10, 10],
      [0, 10],
    ];
    expect(inside([5, 5], sq)).toBe(true);
    expect(inside([15, 5], sq)).toBe(false);
    const w = win("A", "2026-10-01T00:00:00Z", "Sent the deck");
    const hits = [{ key: "A", polys: [sq], windows: [{ w, poly: sq }], top: [5, 0] as [number, number] }];
    expect(pick(hits, [5, 5])).toEqual({ key: "A", window: w });
    expect(pick(hits, [50, 5])).toBeNull();
  });
});
