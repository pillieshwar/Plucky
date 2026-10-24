import type { CityWindow, Task } from "./types";

/**
 * Your city: every finished task lights a window. Each project is a
 * building that grows a floor at a time as you finish its tasks; tasks in
 * no project live on Main Street. Nothing ever goes dark — the city is
 * made only of work that's done.
 *
 * This file is the model (what's built, where) and a small Canvas renderer
 * for it in 3D: boxes on a grid, seen from any side, no WebGL needed.
 */

export type CityRange = "week" | "month" | "all";

export interface Building {
  /** Project name, or "" for Main Street. */
  key: string;
  name: string;
  project: string | null;
  /** Finished tasks, oldest first: window 0 is on the first floor. */
  windows: CityWindow[];
  /** Tasks still open. */
  open: number;
  /** Nothing finished yet: a lot with a crane. */
  planned: boolean;
  /** A project with work done and nothing left open: its rooftop light is on. */
  finished: boolean;
  /** Lot on the grid. */
  gx: number;
  gy: number;
  /** Windows per side, per floor. */
  per: number;
  /** Floors with windows (the lobby comes on top of these). */
  floors: number;
  /** Footprint, in world units. */
  size: number;
}

export interface City {
  buildings: Building[];
  total: number;
  /** When the first window was lit. */
  founded: string | null;
}

export const MAIN_STREET = "Main Street";
/** Lot spacing, floor height and window size, in world units. */
export const LOT = 3.2;
export const FLOOR = 0.36;
const MAX_FLOORS = 72;

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

/** How wide and tall a building with `n` windows is. */
export function shape(n: number): { per: number; floors: number; size: number } {
  // Slim towers: two windows a side until a building is big, then wider.
  let per = n <= 90 ? 2 : n <= 300 ? 3 : 4;
  if (Math.ceil(n / (per * 4)) > MAX_FLOORS) per = Math.ceil(n / (4 * MAX_FLOORS));
  const floors = Math.max(1, Math.ceil(n / (per * 4)));
  return { per, floors, size: Math.min(LOT - 0.55, 0.5 + per * 0.34) };
}

export function buildCity(windows: CityWindow[], tasks: Task[]): City {
  const byKey = new Map<string, { project: string | null; windows: CityWindow[]; open: number }>();
  const get = (project: string | null) => {
    const key = project ?? "";
    let b = byKey.get(key);
    if (!b) {
      b = { project, windows: [], open: 0 };
      byKey.set(key, b);
    }
    return b;
  };
  get(null);
  for (const w of windows) get(w.project).windows.push(w);
  for (const t of tasks) if (!t.done) get(t.project).open += 1;
  const sorted = [...byKey.entries()].sort(([ka, a], [kb, b]) => {
    if (ka === "") return -1;
    if (kb === "") return 1;
    // Founded first, first; lots still being planned go last.
    const fa = a.windows[0]?.completed_at;
    const fb = b.windows[0]?.completed_at;
    if (fa && fb && fa !== fb) return fa < fb ? -1 : 1;
    if (!fa !== !fb) return fa ? -1 : 1;
    return ka.localeCompare(kb);
  });
  const places = lots(sorted.length);
  const buildings: Building[] = sorted.map(([key, b], i) => {
    const s = shape(b.windows.length);
    return {
      key,
      name: key || MAIN_STREET,
      project: b.project,
      windows: b.windows,
      open: b.open,
      planned: b.windows.length === 0,
      finished: key !== "" && b.windows.length > 0 && b.open === 0,
      gx: places[i][0],
      gy: places[i][1],
      ...s,
    };
  });
  const founded = windows.reduce<string | null>((m, w) => (m === null || w.completed_at < m ? w.completed_at : m), null);
  return { buildings, total: windows.length, founded };
}

/** Where a window sits: floor (1-based; 0 is the lobby), side (0–3) and slot. */
export function windowSpot(i: number, per: number): { floor: number; side: number; slot: number } {
  const perFloor = per * 4;
  const rem = i % perFloor;
  return { floor: 1 + Math.floor(i / perFloor), side: Math.floor(rem / per), slot: rem % per };
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
  /** In the same length of time just before the range (week and month only). */
  before: number | null;
  tallest: Building | null;
  finished: number;
  /** Weekday with the most windows lit in the range, and how many. */
  brightest: { day: string; count: number } | null;
}

export function cityStats(city: City, range: CityRange, now: Date, locale?: string): CityStats {
  const from = rangeStart(range, now);
  const today = startOfToday(now);
  const span = range === "week" ? 7 * DAY : 30 * DAY;
  let inRange = 0;
  let todayN = 0;
  let before = 0;
  const byDay = new Map<string, number>();
  for (const b of city.buildings) {
    for (const w of b.windows) {
      const t = Date.parse(w.completed_at);
      if (t >= today) todayN += 1;
      if (t >= from) {
        inRange += 1;
        const d = new Date(t).toLocaleDateString(locale, { weekday: "long" });
        byDay.set(d, (byDay.get(d) ?? 0) + 1);
      } else if (range !== "all" && t >= from - span) before += 1;
    }
  }
  let brightest: { day: string; count: number } | null = null;
  for (const [day, count] of byDay) if (!brightest || count > brightest.count) brightest = { day, count };
  const built = city.buildings.filter((b) => !b.planned);
  const tallest = built.reduce<Building | null>((m, b) => (!m || b.windows.length > m.windows.length ? b : m), null);
  return {
    inRange,
    today: todayN,
    before: range === "all" ? null : before,
    tallest,
    finished: city.buildings.filter((b) => b.finished).length,
    brightest,
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

// ── 3D drawing ────────────────────────────────────────────────────────────────

export interface CityCamera {
  /** Turn around the city, radians. */
  yaw: number;
  /** How far above: 0 = side on, π/2 = straight down. */
  pitch: number;
  /** 1 = fits the view. */
  zoom: number;
}
export const DEFAULT_CAMERA: CityCamera = { yaw: 0.72, pitch: 0.58, zoom: 1 };

export interface CityPalette {
  skyTop: string;
  skyBottom: string;
  stars: boolean;
  ground: string;
  street: string;
  lamp: string;
  wall: [number, number, number];
  roof: string;
  dark: string;
  lit: string;
  fresh: string;
  glow: string;
  beacon: string;
  crane: string;
  label: string;
  labelBg: string;
  labelEdge: string;
  pick: string;
}

export const NIGHT: CityPalette = {
  skyTop: "#090a11",
  skyBottom: "#1a1d2e",
  stars: true,
  ground: "#12141e",
  street: "#1c2030",
  lamp: "#ffd27a",
  wall: [40, 43, 66],
  roof: "#3c405a",
  dark: "#161926",
  lit: "#c4974c",
  fresh: "#ffd27a",
  glow: "rgba(255, 223, 150, 0.22)",
  beacon: "#d9d5ff",
  crane: "#6b7090",
  label: "#c9cddc",
  labelBg: "rgba(13, 14, 20, 0.8)",
  labelEdge: "#2c2f40",
  pick: "#a29bff",
};

export const DUSK: CityPalette = {
  skyTop: "#f3c3a2",
  skyBottom: "#fbe8d8",
  stars: false,
  ground: "#e9d6c8",
  street: "#dcc4b3",
  lamp: "#f2a65a",
  wall: [128, 98, 108],
  roof: "#9b7b84",
  dark: "#5e4852",
  lit: "#d9a04f",
  fresh: "#ffc768",
  glow: "rgba(255, 199, 104, 0.3)",
  beacon: "#5249d9",
  crane: "#8b6c73",
  label: "#3d2f35",
  labelBg: "rgba(255, 255, 255, 0.85)",
  labelEdge: "#e2cfc2",
  pick: "#5249d9",
};

type Pt = [number, number];
export interface CityHit {
  key: string;
  polys: Pt[][];
  windows: { w: CityWindow; poly: Pt[] }[];
  top: Pt;
}

export interface DrawOptions {
  palette: CityPalette;
  range: CityRange;
  now: Date;
  labels: boolean;
  /** Building under the pointer, outlined. */
  hover: string | null;
  /** Leave room at the top and bottom (for headers and stats), in px. */
  padTop?: number;
  padBottom?: number;
  /** Draw the sky (off when the page draws its own background). */
  sky?: boolean;
}

function seeded(seed: number) {
  let s = seed >>> 0 || 1;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/** Draw the city; returns what's where, for clicks and hovers. */
export function drawCity(ctx: CanvasRenderingContext2D, w: number, h: number, city: City, cam: CityCamera, o: DrawOptions): CityHit[] {
  const pal = o.palette;
  const padTop = o.padTop ?? 0;
  const padBottom = o.padBottom ?? 0;
  if (o.sky !== false) {
    const g = ctx.createLinearGradient(0, 0, 0, h);
    g.addColorStop(0, pal.skyTop);
    g.addColorStop(1, pal.skyBottom);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);
    if (pal.stars) {
      const rnd = seeded(7);
      ctx.fillStyle = "#cfd3ff";
      const n = Math.round((w * h) / 4200);
      for (let i = 0; i < n; i++) {
        ctx.globalAlpha = 0.2 + rnd() * 0.55;
        ctx.beginPath();
        ctx.arc(rnd() * w, rnd() * h * 0.6, 0.4 + rnd() * 0.8, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.globalAlpha = 1;
    }
  }

  const cy = Math.cos(cam.yaw);
  const sy = Math.sin(cam.yaw);
  const sp = Math.sin(cam.pitch);
  const cp = Math.cos(cam.pitch);
  const rot = (x: number, y: number) => [x * cy - y * sy, x * sy + y * cy] as const;
  const raw = (x: number, y: number, z: number): Pt => {
    const [xr, yr] = rot(x, y);
    return [xr, yr * sp - z * cp];
  };

  // Fit: the bounds of everything, at zoom 1.
  const bs = city.buildings;
  const pad = LOT * 0.5;
  let minX = 0;
  let maxX = 0;
  let minY = 0;
  let maxY = 0;
  let gMin = 0;
  let gMax = 0;
  for (const b of bs) {
    gMin = Math.min(gMin, b.gx, b.gy);
    gMax = Math.max(gMax, b.gx, b.gy);
  }
  const g0 = gMin * LOT - pad;
  const g1 = gMax * LOT + pad;
  const corners: [number, number, number][] = [
    [g0, g0, 0],
    [g1, g0, 0],
    [g1, g1, 0],
    [g0, g1, 0],
  ];
  for (const b of bs) {
    const hgt = heightOf(b);
    const x = b.gx * LOT;
    const y = b.gy * LOT;
    corners.push([x, y, hgt + (b.planned ? 2.4 : b.finished ? 0.9 : 0.2)]);
  }
  for (const [x, y, z] of corners) {
    const [a, c] = raw(x, y, z);
    minX = Math.min(minX, a);
    maxX = Math.max(maxX, a);
    minY = Math.min(minY, c);
    maxY = Math.max(maxY, c);
  }
  const availH = h - padTop - padBottom;
  const fit = Math.min((w * 0.86) / Math.max(1, maxX - minX), (availH * 0.84) / Math.max(1, maxY - minY));
  const k = fit * cam.zoom;
  const ox = w / 2 - ((minX + maxX) / 2) * k;
  const oy = padTop + availH / 2 - ((minY + maxY) / 2) * k;
  const P = (x: number, y: number, z: number): Pt => {
    const [a, c] = raw(x, y, z);
    return [ox + a * k, oy + c * k];
  };
  const poly = (pts: Pt[], fill: string) => {
    ctx.beginPath();
    ctx.moveTo(pts[0][0], pts[0][1]);
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
    ctx.closePath();
    ctx.fillStyle = fill;
    ctx.fill();
  };

  // Ground and streets.
  poly(
    corners.slice(0, 4).map(([x, y, z]) => P(x, y, z)),
    pal.ground,
  );
  ctx.strokeStyle = pal.street;
  ctx.lineWidth = Math.max(1, 0.32 * k);
  ctx.lineCap = "butt";
  for (let gi = gMin; gi <= gMax + 1; gi++) {
    const s = (gi - 0.5) * LOT;
    if (s <= g0 || s >= g1) continue;
    for (const [a, b] of [
      [P(s, g0, 0), P(s, g1, 0)],
      [P(g0, s, 0), P(g1, s, 0)],
    ] as [Pt, Pt][]) {
      ctx.beginPath();
      ctx.moveTo(a[0], a[1]);
      ctx.lineTo(b[0], b[1]);
      ctx.stroke();
    }
  }
  // Street lamps at the crossings.
  ctx.fillStyle = pal.lamp;
  for (let gi = gMin; gi <= gMax + 1; gi++) {
    for (let gj = gMin; gj <= gMax + 1; gj++) {
      const [lx, ly] = P((gi - 0.5) * LOT, (gj - 0.5) * LOT, 0);
      ctx.globalAlpha = 0.75;
      ctx.beginPath();
      ctx.arc(lx, ly, Math.max(1, 0.06 * k), 0, Math.PI * 2);
      ctx.fill();
    }
  }
  ctx.globalAlpha = 1;

  // Buildings, far to near.
  const from = rangeStart(o.range, o.now);
  const todayStart = startOfToday(o.now);
  const order = [...bs].sort((a, b) => rot(a.gx, a.gy)[1] - rot(b.gx, b.gy)[1]);
  const hits: CityHit[] = [];
  const [wr, wg, wb] = pal.wall;
  for (const b of order) {
    const half = b.size / 2;
    const x0 = b.gx * LOT - half;
    const x1 = b.gx * LOT + half;
    const y0 = b.gy * LOT - half;
    const y1 = b.gy * LOT + half;
    const H = heightOf(b);
    // Sides: outward normal, and the edge they run along (left to right seen from outside).
    const sides: { n: [number, number]; a: [number, number]; b: [number, number] }[] = [
      { n: [0, -1], a: [x1, y0], b: [x0, y0] },
      { n: [1, 0], a: [x1, y1], b: [x1, y0] },
      { n: [0, 1], a: [x0, y1], b: [x1, y1] },
      { n: [-1, 0], a: [x0, y0], b: [x0, y1] },
    ];
    const polys: Pt[][] = [];
    const wins: CityHit["windows"] = [];
    ctx.globalAlpha = b.planned ? 0.5 : 1;
    sides.forEach((s, si) => {
      const [nx, ny] = rot(s.n[0], s.n[1]);
      if (ny <= 0.001) return;
      const light = 0.62 + 0.38 * Math.max(0, nx * 0.6 + ny * 0.8);
      const wall = `rgb(${Math.round(wr * light)}, ${Math.round(wg * light)}, ${Math.round(wb * light)})`;
      const face = [P(s.a[0], s.a[1], 0), P(s.b[0], s.b[1], 0), P(s.b[0], s.b[1], H), P(s.a[0], s.a[1], H)];
      poly(face, wall);
      polys.push(face);
      if (b.planned) return;
      // Windows on this side: every slot of every floor, lit if a task is done there.
      const slots = b.per;
      const along = (t: number): [number, number] => [s.a[0] + (s.b[0] - s.a[0]) * t, s.a[1] + (s.b[1] - s.a[1]) * t];
      for (let f = 1; f <= b.floors; f++) {
        const z0 = f * FLOOR + FLOOR * 0.22;
        const z1 = z0 + FLOOR * 0.5;
        for (let sl = 0; sl < slots; sl++) {
          const i = (f - 1) * slots * 4 + si * slots + sl;
          const win = b.windows[i];
          const t0 = (sl + 0.25) / slots;
          const t1 = (sl + 0.75) / slots;
          const [ax, ay] = along(t0);
          const [bx, by] = along(t1);
          const q = [P(ax, ay, z0), P(bx, by, z0), P(bx, by, z1), P(ax, ay, z1)];
          if (!win) {
            poly(q, pal.dark);
            continue;
          }
          const t = Date.parse(win.completed_at);
          // "All time" brightens only today's; otherwise the range's.
          const fresh = o.range === "all" ? t >= todayStart : t >= from;
          if (fresh) {
            // A soft halo: the window, a little bigger, faintly.
            const c = centroid(q);
            const halo = q.map(([px, py]) => [c[0] + (px - c[0]) * 1.7, c[1] + (py - c[1]) * 1.9] as Pt);
            poly(halo, pal.glow);
          }
          poly(q, fresh ? pal.fresh : pal.lit);
          wins.push({ w: win, poly: q });
        }
      }
    });
    const roof = [P(x0, y0, H), P(x1, y0, H), P(x1, y1, H), P(x0, y1, H)];
    poly(roof, pal.roof);
    polys.push(roof);
    ctx.globalAlpha = 1;
    if (b.planned) {
      // A crane: planned, not built yet.
      const base = P(b.gx * LOT, b.gy * LOT, H);
      const top = P(b.gx * LOT, b.gy * LOT, H + 2.1);
      const j0 = P(b.gx * LOT - 1.0, b.gy * LOT, H + 1.95);
      const j1 = P(b.gx * LOT + 1.4, b.gy * LOT, H + 1.95);
      const hook = P(b.gx * LOT + 1.2, b.gy * LOT, H + 1.1);
      ctx.strokeStyle = pal.crane;
      ctx.lineWidth = Math.max(1, 0.05 * k);
      ctx.beginPath();
      ctx.moveTo(base[0], base[1]);
      ctx.lineTo(top[0], top[1]);
      ctx.moveTo(j0[0], j0[1]);
      ctx.lineTo(j1[0], j1[1]);
      ctx.moveTo(j1[0] - (j1[0] - j0[0]) * 0.08, j1[1] - (j1[1] - j0[1]) * 0.08);
      ctx.lineTo(hook[0], hook[1]);
      ctx.stroke();
    }
    if (b.finished) {
      const base = P(b.gx * LOT, b.gy * LOT, H);
      const tip = P(b.gx * LOT, b.gy * LOT, H + 0.6);
      ctx.strokeStyle = pal.crane;
      ctx.lineWidth = Math.max(1, 0.04 * k);
      ctx.beginPath();
      ctx.moveTo(base[0], base[1]);
      ctx.lineTo(tip[0], tip[1]);
      ctx.stroke();
      ctx.fillStyle = pal.glow;
      ctx.beginPath();
      ctx.arc(tip[0], tip[1], Math.max(2.5, 0.13 * k), 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = pal.beacon;
      ctx.beginPath();
      ctx.arc(tip[0], tip[1], Math.max(1.5, 0.08 * k), 0, Math.PI * 2);
      ctx.fill();
    }
    if (o.hover === b.key) {
      ctx.strokeStyle = pal.pick;
      ctx.lineWidth = 2;
      for (const p of polys) {
        ctx.beginPath();
        ctx.moveTo(p[0][0], p[0][1]);
        for (const q of p.slice(1)) ctx.lineTo(q[0], q[1]);
        ctx.closePath();
        ctx.stroke();
      }
    }
    hits.push({ key: b.key, polys, windows: wins, top: P(b.gx * LOT, b.gy * LOT, H + (b.planned ? 2.3 : b.finished ? 0.75 : 0)) });
  }

  // Names above the roofs, nearest first, skipping any that would overlap.
  if (o.labels) {
    ctx.font = `500 ${Math.round(Math.min(13, Math.max(10.5, k * 0.33)))}px -apple-system, BlinkMacSystemFont, "SF Pro Text", system-ui, sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    const placed: [number, number, number, number][] = [];
    const byKey = new Map(bs.map((b) => [b.key, b] as const));
    for (const hit of [...hits].reverse()) {
      const b = byKey.get(hit.key)!;
      const text = b.name;
      const tw = ctx.measureText(text).width + 18;
      const th = 20;
      const x = hit.top[0] - tw / 2;
      const y = hit.top[1] - th - 8;
      const overlaps = placed.some(([px, py, pw, ph]) => x < px + pw && x + tw > px && y < py + ph && y + th > py);
      if (overlaps && o.hover !== b.key) continue;
      placed.push([x, y, tw, th]);
      ctx.fillStyle = pal.labelBg;
      ctx.strokeStyle = o.hover === b.key ? pal.pick : pal.labelEdge;
      ctx.lineWidth = 1;
      roundRect(ctx, x, y, tw, th, th / 2);
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = pal.label;
      ctx.fillText(text, hit.top[0], y + th / 2 + 0.5);
    }
  }
  return hits.reverse();
}

export function heightOf(b: Building): number {
  return b.planned ? FLOOR * 1.2 : (b.floors + 1.35) * FLOOR;
}

function centroid(q: Pt[]): Pt {
  return [(q[0][0] + q[1][0] + q[2][0] + q[3][0]) / 4, (q[0][1] + q[1][1] + q[2][1] + q[3][1]) / 4];
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/** Is the point inside the polygon? */
export function inside(p: Pt, poly: Pt[]): boolean {
  let hit = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i];
    const [xj, yj] = poly[j];
    if (yi > p[1] !== yj > p[1] && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) hit = !hit;
  }
  return hit;
}

/** What's under a point: the nearest building, and the window if on one. */
export function pick(hits: CityHit[], p: Pt): { key: string; window: CityWindow | null } | null {
  for (const h of hits) {
    if (!h.polys.some((poly) => inside(p, poly))) continue;
    const win = h.windows.find((x) => inside(p, x.poly));
    return { key: h.key, window: win?.w ?? null };
  }
  return null;
}
