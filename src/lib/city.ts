import type { CityWindow, FloorSummary, ProjectSummary, Task } from "./types";

/**
 * Your city, with you as its mayor.
 *
 * - A project is a building; its headings are floors; each task is a room.
 * - A finished task is a lit room; an open one is a dark room.
 * - Tasks in a project but on no floor wait in the building's lobby, on the
 *   ground. Tasks in no project live on Main Street.
 * - Floors are stacked by size — the most rooms at the bottom — so every
 *   building narrows as it rises. Each floor is as wide as its rooms need.
 * - A building with nothing finished yet is under construction; one with no
 *   rooms at all is an empty lot with a crane.
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
}

export interface Floor {
  /** The heading, or null for the lobby. */
  name: string | null;
  /** "Lobby", "1st Floor: Travel". */
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
  /** Project name, or "" for Main Street. */
  key: string;
  name: string;
  project: string | null;
  /** Bottom to top: the lobby first, then the floors by size. */
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
  /** Finished tasks, all of them. */
  total: number;
  founded: string | null;
}

export const MAIN_STREET = "Main Street";
/** Lot spacing and storey height, in world units. */
export const LOT = 3.6;
export const FLOOR = 0.36;
const MAX_PER = 7;
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
  const per = Math.min(MAX_PER, Math.max(1, Math.ceil(n / 4)));
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
  if (hasLobby || lobby.length || !sorted.length) out.push({ name: null, label: "Lobby", rooms: lobby, ...floorShape(lobby.length) });
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
  get(null);
  for (const p of projects) get(p.name);
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
    const b = get(t.project);
    b.open += 1;
    put(b, t.heading, { id: t.id, title: t.title, lit: false, at: null });
    if (today && t.due_date === today && t.due_time && !t.someday) b.today.push({ time: t.due_time, title: t.title });
  }
  const sorted = [...byKey.entries()].sort(([ka, a], [kb, b]) => {
    if (ka === "") return -1;
    if (kb === "") return 1;
    // Founded first, first; buildings with nothing done yet go last.
    if (a.first && b.first && a.first !== b.first) return a.first < b.first ? -1 : 1;
    if (!a.first !== !b.first) return a.first ? -1 : 1;
    return ka.localeCompare(kb);
  });
  const places = lots(sorted.length);
  const buildings: Building[] = sorted.map(([key, b], i) => {
    // Lit rooms first (in the order they were finished), then the open ones.
    const order = (rooms: Room[]) => [...rooms.filter((r) => r.lit).sort((x, y) => (x.at ?? "").localeCompare(y.at ?? "")), ...rooms.filter((r) => !r.lit)];
    const floors = stack(
      order(b.lobby),
      [...b.floors.entries()].map(([name, rooms]) => ({ name, rooms: order(rooms) })),
      key !== "",
    );
    const rooms = b.open + b.done;
    return {
      key,
      name: key || MAIN_STREET,
      project: b.project,
      floors,
      open: b.open,
      done: b.done,
      planned: rooms === 0 && key !== "",
      building: rooms > 0 && b.done === 0,
      finished: key !== "" && b.done > 0 && b.open === 0,
      today: b.today.sort((x, y) => x.time.localeCompare(y.time)),
      gx: places[i][0],
      gy: places[i][1],
    };
  });
  const founded = windows.reduce<string | null>((m, w) => (m === null || w.completed_at < m ? w.completed_at : m), null);
  return { buildings, total: windows.length, founded };
}

/** The building's height, in world units (to the roof). */
export function heightOf(b: Building): number {
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
    open += b.open;
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
  const built = city.buildings.filter((b) => !b.planned);
  const tallest = built.reduce<Building | null>((m, b) => (!m || heightOf(b) > heightOf(m) ? b : m), null);
  return {
    inRange,
    today: todayN,
    before: range === "all" ? null : before,
    tallest,
    finished: city.buildings.filter((b) => b.finished).length,
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
