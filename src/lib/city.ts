import type { CityWindow, FloorSummary, ProjectSummary, Task } from "./types";

/**
 * Lights On — your city, with you as its mayor.
 *
 * - Every project is an apartment building; its sections are floors.
 * - Every task is a home. A new task is an empty home, its window dark.
 *   Finishing it means someone moves in, and the lights come on — for good.
 * - Sub-tasks get a home ready: once some are ticked, its window glows
 *   faintly. An overdue home blinks amber: someone's waiting at the door.
 * - Tasks in a project but on no floor live on the ground floor. Tasks in
 *   no project are houses on the edge of town, with porch lights.
 * - Someday ideas are "Coming soon" plots.
 * - The population is every task you've finished.
 *
 * This file is the model (what's built, where); CityScene draws it in 3D.
 */

export type CityRange = "week" | "month" | "all";

export interface Room {
  id: number;
  title: string;
  lit: boolean;
  /** When it was finished (lit rooms). */
  at: string | null;
  /** Sub-tasks done of all, when the task has any (an open home being readied). */
  readying?: { done: number; total: number } | null;
  /** Open and past its day or deadline: blinks amber. */
  late?: boolean;
}

export interface Floor {
  /** The heading, or null for the lobby. */
  name: string | null;
  /** "Ground floor", "1st Floor: Travel". */
  label: string;
  rooms: Room[];
  /** Rooms along each side. */
  per: number;
  /** How many storeys the floor takes (a big floor is several high). */
  levels: number;
  /** Footprint, in world units. */
  size: number;
}

export interface Billboard {
  time: string;
  title: string;
}

export interface Building {
  /** Project name; HOUSES_KEY for the houses, SOMEDAY_KEY for the plots. */
  key: string;
  /** A tower (a project), the houses (tasks in no project), or Coming soon plots (Someday). */
  kind: "tower" | "houses" | "plots";
  /** Every lot it stands on (houses and plots can spread over several). */
  lots: [number, number][];
  name: string;
  project: string | null;
  /** Bottom to top: the ground floor first, then the floors by size. */
  floors: Floor[];
  open: number;
  done: number;
  /** No rooms at all: an empty lot with a crane. */
  planned: boolean;
  /** Rooms, but none lit yet: trucks come and go. */
  building: boolean;
  /** Everything lit: the rooftop light is on. */
  finished: boolean;
  /** Today's timed rooms, in time order: shown on a billboard. */
  today: Billboard[];
  gx: number;
  gy: number;
}

export interface City {
  buildings: Building[];
  /** Finished tasks, all of them: the population. */
  total: number;
  /** Someday ideas, shown as Coming soon plots. */
  comingSoon: { id: number; title: string; project: string | null }[];
  founded: string | null;
}

export const HOUSES = "Houses";
export const HOUSES_KEY = "";
export const SOMEDAY_KEY = "~someday";
/** Houses on one lot (a 3 × 3 block). */
export const HOUSES_PER_LOT = 9;
/** Lot spacing and storey height, in world units. */
export const LOT = 3.6;
export const FLOOR = 0.36;
const MAX_PER = 5;
/** Width of one room along a side. */
export const ROOM = 0.36;

export function ordinal(n: number): string {
  const s = ["th", "st", "nd", "rd"];
  const v = n % 100;
  return `${n}${s[(v - 20) % 10] ?? s[v] ?? s[0]}`;
}

/** Lots spiral out from the middle, so the oldest buildings are downtown. */
export function lots(n: number): [number, number][] {
  const out: [number, number][] = [];
  for (let r = 0; out.length < n; r++) {
    const ring: [number, number][] = [];
    for (let x = -r; x <= r; x++) {
      for (let y = -r; y <= r; y++) {
        if (Math.max(Math.abs(x), Math.abs(y)) === r) ring.push([x + 0, y + 0]);
      }
    }
    ring.sort((a, b) => Math.hypot(a[0], a[1]) - Math.hypot(b[0], b[1]) || Math.atan2(a[1], a[0]) - Math.atan2(b[1], b[0]));
    out.push(...ring);
  }
  return out.slice(0, n);
}

/** How a floor with `n` rooms is laid out: rooms per side, storeys, footprint. */
export function floorShape(n: number): { per: number; levels: number; size: number } {
  // Wider with more rooms, but towers rather than slabs: width grows with
  // the square root, the rest goes up in storeys.
  const per = Math.min(MAX_PER, Math.max(1, Math.ceil(Math.sqrt(n / 2))));
  const levels = Math.max(1, Math.ceil(n / (per * 4)));
  return { per, levels, size: 0.3 + per * ROOM };
}

/**
 * Stack a building: the lobby on the ground, then floors with the most rooms
 * first. A floor is never wider than the one below it (the lobby widens to
 * carry what's above).
 */
export function stack(lobby: Room[], floors: { name: string; rooms: Room[] }[], hasLobby: boolean): Floor[] {
  const sorted = [...floors].sort((a, b) => b.rooms.length - a.rooms.length || a.name.localeCompare(b.name));
  const out: Floor[] = [];
  if (hasLobby || lobby.length || !sorted.length) out.push({ name: null, label: "Ground floor", rooms: lobby, ...floorShape(lobby.length) });
  sorted.forEach((f, i) => out.push({ name: f.name, label: `${ordinal(i + 1)} Floor: ${f.name}`, rooms: f.rooms, ...floorShape(f.rooms.length) }));
  // Narrowing upward: each floor at most as wide as the one under it.
  for (let i = out.length - 2; i >= 0; i--) out[i].size = Math.max(out[i].size, out[i + 1].size);
  return out;
}

export function buildCity(
  windows: CityWindow[],
  tasks: Task[],
  projects: ProjectSummary[] = [],
  floorList: FloorSummary[] = [],
  today: string | null = null,
): City {
  type Acc = { project: string | null; lobby: Room[]; floors: Map<string, Room[]>; open: number; done: number; first: string | null; today: Billboard[] };
  const byKey = new Map<string, Acc>();
  const get = (project: string | null) => {
    const key = project ?? "";
    let b = byKey.get(key);
    if (!b) {
      b = { project, lobby: [], floors: new Map(), open: 0, done: 0, first: null, today: [] };
      byKey.set(key, b);
    }
    return b;
  };
  const put = (b: Acc, heading: string | null, room: Room) => {
    if (b.project && heading) b.floors.set(heading, [...(b.floors.get(heading) ?? []), room]);
    else b.lobby.push(room);
  };
  for (const p of projects) get(p.name);
  const comingSoon: City["comingSoon"] = [];
  for (const f of floorList) {
    const b = get(f.project);
    if (!b.floors.has(f.name)) b.floors.set(f.name, []);
  }
  for (const w of windows) {
    const b = get(w.project);
    b.done += 1;
    if (!b.first || w.completed_at < b.first) b.first = w.completed_at;
    put(b, w.heading, { id: w.id, title: w.title, lit: true, at: w.completed_at });
  }
  for (const t of tasks) {
    if (t.done) continue;
    if (t.someday || t.paused) {
      comingSoon.push({ id: t.id, title: t.title, project: t.project });
      continue;
    }
    const b = get(t.project);
    b.open += 1;
    const steps = t.checklist ?? [];
    const day = [t.due_date, t.deadline].filter((d): d is string => !!d).sort()[0];
    put(b, t.heading, {
      id: t.id,
      title: t.title,
      lit: false,
      at: null,
      readying: steps.length ? { done: steps.filter((s) => s.done).length, total: steps.length } : null,
      late: !!today && !!day && day < today,
    });
    if (today && t.due_date === today && t.due_time) b.today.push({ time: t.due_time, title: t.title });
  }
  const houses = byKey.get(HOUSES_KEY);
  byKey.delete(HOUSES_KEY);
  const sorted = [...byKey.entries()].sort(([ka, a], [kb, b]) => {
    // Founded first, first (downtown); buildings with nothing done yet go last.
    if (a.first && b.first && a.first !== b.first) return a.first < b.first ? -1 : 1;
    if (!a.first !== !b.first) return a.first ? -1 : 1;
    return ka.localeCompare(kb);
  });
  // Towers downtown, then the houses' blocks, then the Coming soon plots.
  const houseRooms = houses ? houses.lobby.length : 0;
  const houseLots = houseRooms ? Math.ceil(houseRooms / HOUSES_PER_LOT) : 0;
  const places = lots(sorted.length + houseLots + (comingSoon.length ? 1 : 0));
  // Lit homes first (in the order people moved in), then the empty ones.
  const order = (rooms: Room[]) => [...rooms.filter((r) => r.lit).sort((x, y) => (x.at ?? "").localeCompare(y.at ?? "")), ...rooms.filter((r) => !r.lit)];
  const buildings: Building[] = sorted.map(([key, b], i) => {
    const floors = stack(
      order(b.lobby),
      [...b.floors.entries()].map(([name, rooms]) => ({ name, rooms: order(rooms) })),
      true,
    );
    const rooms = b.open + b.done;
    return {
      key,
      kind: "tower",
      lots: [places[i]],
      name: key,
      project: b.project,
      floors,
      open: b.open,
      done: b.done,
      planned: rooms === 0,
      building: rooms > 0 && b.done === 0,
      finished: b.done > 0 && b.open === 0,
      today: b.today.sort((x, y) => x.time.localeCompare(y.time)),
      gx: places[i][0],
      gy: places[i][1],
    };
  });
  let next = sorted.length;
  if (houses && houseRooms) {
    const hl = places.slice(next, next + houseLots);
    next += houseLots;
    const rooms = order(houses.lobby);
    buildings.push({
      key: HOUSES_KEY,
      kind: "houses",
      lots: hl,
      name: HOUSES,
      project: null,
      floors: [{ name: null, label: HOUSES, rooms, per: 1, levels: 1, size: 0.5 }],
      open: houses.open,
      done: houses.done,
      planned: false,
      building: false,
      finished: false,
      today: houses.today.sort((x, y) => x.time.localeCompare(y.time)),
      gx: hl[0][0],
      gy: hl[0][1],
    });
  }
  if (comingSoon.length) {
    const at = places[next];
    buildings.push({
      key: SOMEDAY_KEY,
      kind: "plots",
      lots: [at],
      name: "Coming soon",
      project: null,
      floors: [],
      open: comingSoon.length,
      done: 0,
      planned: false,
      building: false,
      finished: false,
      today: [],
      gx: at[0],
      gy: at[1],
    });
  }
  const founded = windows.reduce<string | null>((m, w) => (m === null || w.completed_at < m ? w.completed_at : m), null);
  return { buildings, total: windows.length, founded, comingSoon };
}

/** The building's height, in world units (to the roof). */
export function heightOf(b: Building): number {
  if (b.kind === "houses") return FLOOR * 1.6;
  if (b.kind === "plots") return FLOOR * 0.8;
  if (b.planned) return FLOOR * 1.2;
  return b.floors.reduce((h, f) => h + f.levels * FLOOR, 0) + FLOOR * 0.6;
}

/** Every room's spot: which floor, storey, side and slot. */
export function roomSpot(f: Floor, i: number): { level: number; side: number; slot: number } {
  const ring = f.per * 4;
  const rem = i % ring;
  return { level: Math.floor(i / ring), side: Math.floor(rem / f.per), slot: rem % f.per };
}

const DAY = 86_400_000;
/** The start of the range shown as "lit recently". */
export function rangeStart(range: CityRange, now: Date): number {
  const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  if (range === "week") return midnight - 6 * DAY;
  if (range === "month") return midnight - 29 * DAY;
  return -Infinity;
}
export const startOfToday = (now: Date) => new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();

export interface CityStats {
  inRange: number;
  today: number;
  before: number | null;
  tallest: Building | null;
  finished: number;
  brightest: { day: string; count: number } | null;
  open: number;
}

export function cityStats(city: City, range: CityRange, now: Date, locale?: string): CityStats {
  const from = rangeStart(range, now);
  const todayStart = startOfToday(now);
  const span = range === "week" ? 7 * DAY : 30 * DAY;
  let inRange = 0;
  let todayN = 0;
  let before = 0;
  let open = 0;
  const byDay = new Map<string, number>();
  for (const b of city.buildings) {
    if (b.kind !== "plots") open += b.open;
    for (const f of b.floors) {
      for (const r of f.rooms) {
        if (!r.lit || !r.at) continue;
        const t = Date.parse(r.at);
        if (t >= todayStart) todayN += 1;
        if (t >= from) {
          inRange += 1;
          const d = new Date(t).toLocaleDateString(locale, { weekday: "long" });
          byDay.set(d, (byDay.get(d) ?? 0) + 1);
        } else if (range !== "all" && t >= from - span) before += 1;
      }
    }
  }
  let brightest: { day: string; count: number } | null = null;
  for (const [day, count] of byDay) if (!brightest || count > brightest.count) brightest = { day, count };
  const built = city.buildings.filter((b) => !b.planned && b.kind === "tower");
  const tallest = built.reduce<Building | null>((m, b) => (!m || heightOf(b) > heightOf(m) ? b : m), null);
  return {
    inRange,
    today: todayN,
    before: range === "all" ? null : before,
    tallest,
    finished: city.buildings.filter((b) => b.finished && b.kind === "tower").length,
    brightest,
    open,
  };
}

export const CITY_NAMES = [
  "Lumen Bay",
  "Night Owl Heights",
  "Harbor Lights",
  "North Spire",
  "Glowtown",
  "Port Lantern",
  "Starling Point",
  "Ember Hill",
  "Moonrise Quay",
  "Brightwater",
  "Copper Lane",
  "Halcyon Row",
];

/** "SR" for "Sam Rivera", "M" when there's no name. */
export function initials(name: string | null): string {
  const parts = (name ?? "").trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return "M";
  return (parts[0][0] + (parts.length > 1 ? parts[parts.length - 1][0] : "")).toUpperCase();
}
