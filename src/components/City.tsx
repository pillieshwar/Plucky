import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import {
  CITY_NAMES,
  DEFAULT_CAMERA,
  DUSK,
  MAIN_STREET,
  NIGHT,
  cityStats,
  drawCity,
  pick,
  type City,
  type CityCamera,
  type CityHit,
  type CityRange,
} from "../lib/city";
import { api } from "../lib/api";
import type { CityWindow } from "../lib/types";

// three.js loads only when the city is first shown (full screen).
const CityScene = lazy(() => import("./CityScene").then((m) => ({ default: m.CityScene })));

const hasWebGL = (() => {
  let ok: boolean | null = null;
  return () => {
    if (ok === null) {
      try {
        const c = document.createElement("canvas");
        ok = !!(c.getContext("webgl2") || c.getContext("webgl"));
      } catch {
        ok = false;
      }
    }
    return ok;
  };
})();

/** The city in 3D (three.js), or drawn flat where WebGL isn't available. */
function City3D(props: {
  city: City;
  range: CityRange;
  now: Date;
  still?: boolean;
  labels?: boolean;
  onPick?: (key: string) => void;
  onHover?: (h: Hover | null) => void;
  onInteract?: () => void;
}) {
  const dark = useDark();
  if (!hasWebGL()) return <CityCanvas {...props} padTop={props.labels ? 64 : 0} padBottom={props.labels ? 110 : 0} />;
  return (
    <Suspense fallback={<div className="city3d" />}>
      <CityScene {...props} dark={dark} />
    </Suspense>
  );
}

const isDark = () => {
  const t = document.documentElement.dataset.theme;
  if (t === "dark") return true;
  if (t === "light") return false;
  return window.matchMedia?.("(prefers-color-scheme: dark)").matches ?? true;
};
const reduceMotion = () => window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;

/** Follow the theme as it changes. */
function useDark(): boolean {
  const [dark, setDark] = useState(isDark);
  useEffect(() => {
    const obs = new MutationObserver(() => setDark(isDark()));
    obs.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    const mq = window.matchMedia?.("(prefers-color-scheme: dark)");
    const on = () => setDark(isDark());
    mq?.addEventListener?.("change", on);
    return () => {
      obs.disconnect();
      mq?.removeEventListener?.("change", on);
    };
  }, []);
  return dark;
}

interface Hover {
  key: string;
  window: CityWindow | null;
  x: number;
  y: number;
}

/**
 * The city in 3D on a canvas. Drag to turn it, scroll to zoom, double-click
 * to reset; click a building to open its project. `still` draws once with
 * no interaction (the corner card).
 */
function CityCanvas({
  city,
  range,
  now,
  still,
  labels,
  padTop = 0,
  padBottom = 0,
  onPick,
  onHover,
  onInteract,
}: {
  city: City;
  range: CityRange;
  now: Date;
  still?: boolean;
  labels?: boolean;
  padTop?: number;
  padBottom?: number;
  onPick?: (key: string) => void;
  onHover?: (h: Hover | null) => void;
  onInteract?: () => void;
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  const [size, setSize] = useState<[number, number]>([0, 0]);
  // The corner card is wide and short: come in closer there.
  const [cam, setCam] = useState<CityCamera>(still ? { ...DEFAULT_CAMERA, zoom: 1.25 } : DEFAULT_CAMERA);
  const [hoverKey, setHoverKey] = useState<string | null>(null);
  const hits = useRef<CityHit[]>([]);
  const drag = useRef<{ x: number; y: number; cam: CityCamera; moved: boolean } | null>(null);
  const spinning = useRef(!still && !reduceMotion());
  const dark = useDark();

  useEffect(() => {
    const el = ref.current?.parentElement;
    if (!el) return;
    const ro = new ResizeObserver(() => setSize([el.clientWidth, el.clientHeight]));
    ro.observe(el);
    setSize([el.clientWidth, el.clientHeight]);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    const c = ref.current;
    if (!c || !size[0] || !size[1]) return;
    const dpr = window.devicePixelRatio || 1;
    c.width = Math.round(size[0] * dpr);
    c.height = Math.round(size[1] * dpr);
    const ctx = c.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    hits.current = drawCity(ctx, size[0], size[1], city, cam, {
      palette: dark ? NIGHT : DUSK,
      range,
      now,
      labels: !!labels,
      hover: hoverKey,
      padTop,
      padBottom,
    });
  }, [city, cam, size, dark, range, now, labels, hoverKey, padTop, padBottom]);

  // A slow turn while nobody's touching it (not for reduced motion).
  useEffect(() => {
    if (still) return;
    let raf = 0;
    let last = performance.now();
    const tick = (t: number) => {
      if (spinning.current) setCam((c) => ({ ...c, yaw: c.yaw + ((t - last) / 1000) * 0.07 }));
      last = t;
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [still]);

  const stop = useCallback(() => {
    if (spinning.current) {
      spinning.current = false;
      onInteract?.();
    }
  }, [onInteract]);

  if (still) return <canvas ref={ref} className="city-canvas" aria-hidden />;

  const at = (e: { clientX: number; clientY: number }) => {
    const r = ref.current!.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top] as [number, number];
  };

  return (
    <canvas
      ref={ref}
      className="city-canvas live"
      tabIndex={0}
      aria-label="Your city in 3D. Arrow keys turn it, plus and minus zoom, 0 resets."
      onPointerDown={(e: ReactPointerEvent<HTMLCanvasElement>) => {
        stop();
        e.currentTarget.setPointerCapture(e.pointerId);
        drag.current = { x: e.clientX, y: e.clientY, cam, moved: false };
      }}
      onPointerMove={(e) => {
        const d = drag.current;
        if (d) {
          const dx = e.clientX - d.x;
          const dy = e.clientY - d.y;
          if (!d.moved && Math.hypot(dx, dy) < 4) return;
          d.moved = true;
          setCam({ ...d.cam, yaw: d.cam.yaw - dx * 0.008, pitch: clamp(d.cam.pitch + dy * 0.005, 0.22, 1.25) });
          onHover?.(null);
          return;
        }
        const p = at(e);
        const hit = pick(hits.current, p);
        setHoverKey(hit?.key ?? null);
        onHover?.(hit ? { ...hit, x: p[0], y: p[1] } : null);
      }}
      onPointerUp={(e) => {
        const d = drag.current;
        drag.current = null;
        if (d && !d.moved) {
          const hit = pick(hits.current, at(e));
          if (hit) onPick?.(hit.key);
        }
      }}
      onPointerLeave={() => {
        if (!drag.current) {
          setHoverKey(null);
          onHover?.(null);
        }
      }}
      onWheel={(e) => {
        stop();
        setCam((c) => ({ ...c, zoom: clamp(c.zoom * Math.exp(-e.deltaY * 0.0015), 0.6, 4) }));
      }}
      onDoubleClick={() => setCam(DEFAULT_CAMERA)}
      onKeyDown={(e) => {
        const step = Math.PI / 12;
        let next: CityCamera | null = null;
        if (e.key === "ArrowLeft") next = { ...cam, yaw: cam.yaw + step };
        else if (e.key === "ArrowRight") next = { ...cam, yaw: cam.yaw - step };
        else if (e.key === "ArrowUp") next = { ...cam, pitch: clamp(cam.pitch + 0.1, 0.22, 1.25) };
        else if (e.key === "ArrowDown") next = { ...cam, pitch: clamp(cam.pitch - 0.1, 0.22, 1.25) };
        else if (e.key === "+" || e.key === "=") next = { ...cam, zoom: clamp(cam.zoom * 1.2, 0.6, 4) };
        else if (e.key === "-") next = { ...cam, zoom: clamp(cam.zoom / 1.2, 0.6, 4) };
        else if (e.key === "0") next = DEFAULT_CAMERA;
        if (next) {
          e.preventDefault();
          e.stopPropagation();
          stop();
          setCam(next);
        }
      }}
    />
  );
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** The city in the corner of full screen: a still picture, its name and this week's count. */
export function CityCard({
  city,
  name,
  now,
  onOpen,
  onShare,
  onHide,
}: {
  city: City;
  name: string | null;
  now: Date;
  onOpen: () => void;
  onShare: () => void;
  onHide: () => void;
}) {
  const stats = useMemo(() => cityStats(city, "week", now), [city, now]);
  const [small, setSmall] = useState(() => {
    try {
      return localStorage.getItem("pluck.cityCard") === "small";
    } catch {
      return false;
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem("pluck.cityCard", small ? "small" : "big");
    } catch {
      // The choice lasts this session.
    }
  }, [small]);
  // A soft glow when a new window lights up.
  const [pulse, setPulse] = useState(false);
  const lastTotal = useRef(city.total);
  useEffect(() => {
    // Not when the city first loads: only for windows lit while you watch.
    if (lastTotal.current > 0 && city.total > lastTotal.current) {
      setPulse(true);
      const t = window.setTimeout(() => setPulse(false), 1400);
      lastTotal.current = city.total;
      return () => window.clearTimeout(t);
    }
    lastTotal.current = city.total;
  }, [city.total]);

  const title = name ?? "Your city";
  if (small) {
    return (
      <button type="button" className={pulse ? "city-pill lit-up" : "city-pill"} onClick={() => setSmall(false)} title="Show your city">
        <BuildingIcon />
        <span>{title}</span>
        <span className="city-pill-count">{stats.inRange}</span>
      </button>
    );
  }
  return (
    <div className={pulse ? "city-card lit-up" : "city-card"}>
      <button type="button" className="city-card-art" onClick={onOpen} aria-label={`Open ${title}`} title="Open your city">
        <City3D city={city} range="week" now={now} still />
      </button>
      <div className="city-card-tools">
        <button type="button" onClick={onShare} aria-label="Share a picture of your city" title="Share">
          <ShareIcon />
        </button>
        <button type="button" onClick={onOpen} aria-label="Open your city" title="Open">
          <ExpandIcon />
        </button>
        <button type="button" onClick={() => setSmall(true)} aria-label="Make the city card small" title="Make small">
          <svg width="11" height="11" viewBox="0 0 12 12" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" aria-hidden>
            <path d="M2.5 6h7" />
          </svg>
        </button>
      </div>
      <div className="city-card-foot">
        <div className="city-card-text">
          <span className="city-card-name">{name ?? "Name your city"}</span>
          <span className="city-card-sub">
            {stats.inRange} rooms lit this week · {city.total} in all
          </span>
        </div>
        {stats.today > 0 && <span className="city-card-today">+{stats.today} today</span>}
        <button type="button" className="city-card-hide" onClick={onHide} title="Hide (turn it back on in Preferences)">
          Hide
        </button>
      </div>
    </div>
  );
}

/**
 * The city, opened over full screen: turn it, zoom in, click a building to
 * go to its project, rename the city, share a picture of it.
 */
export function CityView({
  city,
  name,
  now,
  locale,
  startSharing,
  onName,
  onOpenProject,
  onClose,
  onError,
  onSaved,
}: {
  city: City;
  name: string | null;
  now: Date;
  locale: string;
  startSharing?: boolean;
  onName: (name: string) => void;
  /** Open a building's project (null: Main Street, the tasks in no project). */
  onOpenProject: (project: string | null) => void;
  onClose: () => void;
  onError: (e: unknown) => void;
  onSaved: (path: string) => void;
}) {
  const [range, setRange] = useState<CityRange>("week");
  const [hover, setHover] = useState<Hover | null>(null);
  const [hint, setHint] = useState(true);
  const [renaming, setRenaming] = useState(false);
  const [sharing, setSharing] = useState(!!startSharing && !!name);
  const dark = useDark();
  const stats = useMemo(() => cityStats(city, range, now, locale), [city, range, now, locale]);
  const byKey = useMemo(() => new Map(city.buildings.map((b) => [b.key, b] as const)), [city]);
  const rangeLabel = range === "week" ? "this week" : range === "month" ? "this month" : "in all";

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopImmediatePropagation();
      if (sharing) setSharing(false);
      else if (renaming) setRenaming(false);
      else onClose();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [sharing, renaming, onClose]);

  if (!name) return <NameCity city={city} now={now} onName={onName} onLater={onClose} />;

  const hb = hover ? byKey.get(hover.key) : undefined;
  const delta = stats.before === null ? null : stats.inRange - stats.before;
  return (
    <div className={dark ? "city-view" : "city-view light"} role="dialog" aria-label={`${name}: your city`}>
      <div className="cv-stage">
        <City3D
          city={city}
          range={range}
          now={now}
          labels
          onPick={(key) => onOpenProject(byKey.get(key)?.project ?? null)}
          onHover={setHover}
          onInteract={() => setHint(false)}
        />
      </div>
      <header className="cv-head" data-tauri-drag-region>
        <button type="button" className="cv-back" onClick={onClose} title="Back to your tasks (Esc)">
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
            <path d="M10 3.5 5.5 8l4.5 4.5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          Back
        </button>
        {renaming ? (
          <RenameField
            name={name}
            onDone={(n) => {
              setRenaming(false);
              if (n && n !== name) onName(n);
            }}
          />
        ) : (
          <button type="button" className="cv-name" onClick={() => setRenaming(true)} title="Rename your city">
            {name}
            <PencilIcon />
          </button>
        )}
        <span className="cv-sub" data-tauri-drag-region>
          {city.founded ? `Founded ${new Date(city.founded).toLocaleDateString(locale, { month: "short", day: "numeric", year: "numeric" })} · ` : ""}
          {city.buildings.length} {city.buildings.length === 1 ? "building" : "buildings"}
        </span>
        <span className="cv-gap" data-tauri-drag-region />
        <div className="cv-seg" role="radiogroup" aria-label="Show">
          {(
            [
              ["week", "7 days"],
              ["month", "30 days"],
              ["all", "All time"],
            ] as [CityRange, string][]
          ).map(([v, t]) => (
            <button key={v} type="button" role="radio" aria-checked={range === v} className={range === v ? "on" : ""} onClick={() => setRange(v)}>
              {t}
            </button>
          ))}
        </div>
        <button type="button" className="cv-share" onClick={() => setSharing(true)}>
          <ShareIcon /> Share
        </button>
        <button type="button" className="cv-close" onClick={onClose} aria-label="Close your city" title="Close (Esc)">
          <svg width="12" height="12" viewBox="0 0 12 12" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden>
            <path d="M3 3l6 6M9 3l-6 6" />
          </svg>
        </button>
      </header>

      {hint && <p className="cv-hint">Drag to turn · scroll to zoom · click a building to open it</p>}

      {hover && hb && (
        <div className="cv-tip" style={{ left: Math.min(hover.x + 16, window.innerWidth - 300), top: Math.min(hover.y + 12, window.innerHeight - 200) }}>
          {hover.window ? (
            <>
              <strong>{hover.window.title}</strong>
              <span>
                {hb.name} · done{" "}
                {new Date(hover.window.completed_at).toLocaleString(locale, { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}
              </span>
            </>
          ) : (
            <>
              <strong>{hb.name}</strong>
              <span>
                {hb.planned ? "Being planned" : `${hb.windows.length} ${hb.windows.length === 1 ? "room" : "rooms"} lit`}
                {hb.open ? ` · ${hb.open} ${hb.open === 1 ? "room" : "rooms"} still open` : hb.finished ? " · every room lit" : ""}
              </span>
              <span className="cv-tip-go">Click to open</span>
            </>
          )}
        </div>
      )}

      <footer className="cv-stats">
        <Stat big={String(stats.inRange)} small={`rooms lit ${rangeLabel}`} note={delta === null ? undefined : delta >= 0 ? `+${delta} on the ${range === "week" ? "week" : "month"} before` : `${delta} on the ${range === "week" ? "week" : "month"} before`} />
        <Stat big={String(city.total)} small="lit since the city began" />
        {stats.tallest && <Stat big={stats.tallest.name} small="tallest building" note={`${stats.tallest.windows.length} rooms lit`} />}
        <Stat big={String(stats.finished)} small={stats.finished === 1 ? "rooftop lit" : "rooftops lit"} note="buildings finished" />
        {stats.brightest && <Stat big={stats.brightest.day} small="brightest day" note={`${stats.brightest.count} done`} />}
        <span className="cv-gap" />
        <div className="cv-legend" aria-label="Legend">
          <span>
            <i className="lg-fresh" /> Room lit {range === "all" ? "today" : rangeLabel}
          </span>
          <span>
            <i className="lg-lit" /> Room lit earlier
          </span>
          <span>
            <i className="lg-beacon" /> Building finished
          </span>
          <span>
            <i className="lg-plan" /> Planned: no rooms lit yet
          </span>
        </div>
      </footer>

      <ul className="sr-only" aria-label="Buildings">
        {city.buildings.map((b) => (
          <li key={b.key}>
            <button type="button" onClick={() => onOpenProject(b.project)}>
              {b.name}: {b.windows.length} rooms lit, {b.open} open. Open {b.project ? "this building" : "rooms in no building"}.
            </button>
          </li>
        ))}
      </ul>

      {sharing && (
        <ShareSheet
          city={city}
          name={name}
          now={now}
          count={cityStats(city, "week", now).inRange}
          onClose={() => setSharing(false)}
          onError={onError}
          onSaved={onSaved}
        />
      )}
    </div>
  );
}

function Stat({ big, small, note }: { big: string; small: string; note?: string }) {
  return (
    <div className="cv-stat">
      <span className="cv-stat-big">{big}</span>
      <span className="cv-stat-small">{small}</span>
      {note && <span className="cv-stat-note">{note}</span>}
    </div>
  );
}

function RenameField({ name, onDone }: { name: string; onDone: (name: string) => void }) {
  const [text, setText] = useState(name);
  const done = useRef(false);
  const finish = (v: string) => {
    if (done.current) return;
    done.current = true;
    onDone(v.trim().slice(0, 40));
  };
  return (
    <input
      className="cv-name-input"
      autoFocus
      value={text}
      maxLength={40}
      aria-label="City name"
      onChange={(e) => setText(e.target.value)}
      onFocus={(e) => e.currentTarget.select()}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Enter") finish(text);
        if (e.key === "Escape") finish(name);
      }}
      onBlur={() => finish(text)}
    />
  );
}

/** The first time: what the city is, and what to call it. */
function NameCity({ city, now, onName, onLater }: { city: City; now: Date; onName: (n: string) => void; onLater: () => void }) {
  const dark = useDark();
  const [text, setText] = useState(CITY_NAMES[0]);
  const [offset, setOffset] = useState(0);
  const picks = [0, 1, 2, 3].map((i) => CITY_NAMES[(i + offset) % CITY_NAMES.length]);
  return (
    <div className={dark ? "city-view naming" : "city-view naming light"} role="dialog" aria-label="Name your city">
      <div className="cv-stage low">
        <City3D city={city} range="week" now={now} still />
      </div>
      <button type="button" className="cv-back nc-back" onClick={onLater} title="Back to your tasks (Esc)">
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
          <path d="M10 3.5 5.5 8l4.5 4.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        Back
      </button>
      <div className="nc-card">
        <p className="nc-kicker">{city.total ? "Your windows are lit" : "Your city starts here"}</p>
        <h2>Every task you finish lights up your city.</h2>
        <p className="nc-text">Each project is a building and each task a room in it. Finish one and its window lights up — the building grows as you go, and nothing ever goes dark. What should we call your city?</p>
        <input
          className="nc-input"
          autoFocus
          value={text}
          maxLength={40}
          aria-label="City name"
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === "Enter" && text.trim()) onName(text.trim());
          }}
        />
        <div className="nc-picks">
          {picks.map((n) => (
            <button key={n} type="button" className={text === n ? "on" : ""} onClick={() => setText(n)}>
              {n}
            </button>
          ))}
          <button type="button" className="nc-shuffle" onClick={() => setOffset((o) => o + 4)}>
            More names
          </button>
        </div>
        <div className="nc-actions">
          <button type="button" className="nc-later" onClick={onLater}>
            Later
          </button>
          <button type="button" className="primary" disabled={!text.trim()} onClick={() => onName(text.trim())}>
            Found the city
          </button>
        </div>
      </div>
    </div>
  );
}

/** Draw the share picture: the city, its name and (optionally) this week's count. */
export function renderShareImage(
  city: City,
  name: string,
  opts: { count: number | null; names: boolean; now: Date; dark: boolean },
): HTMLCanvasElement {
  const W = 1200;
  const H = 630;
  const c = document.createElement("canvas");
  c.width = W;
  c.height = H;
  const ctx = c.getContext("2d")!;
  drawCity(ctx, W, H, city, { yaw: 0.72, pitch: 0.55, zoom: 1.2 }, {
    palette: opts.dark ? NIGHT : DUSK,
    range: "week",
    now: opts.now,
    labels: opts.names,
    hover: null,
    padTop: 110,
    padBottom: 40,
  });
  const ink = opts.dark ? "#ffffff" : "#2d2226";
  const sub = opts.dark ? "rgba(214, 216, 230, 0.9)" : "rgba(61, 47, 53, 0.8)";
  ctx.textAlign = "left";
  ctx.textBaseline = "alphabetic";
  ctx.fillStyle = ink;
  ctx.font = '750 46px -apple-system, BlinkMacSystemFont, "SF Pro Display", system-ui, sans-serif';
  ctx.fillText(name, 48, 84);
  if (opts.count !== null) {
    ctx.fillStyle = sub;
    ctx.font = '500 22px -apple-system, BlinkMacSystemFont, "SF Pro Text", system-ui, sans-serif';
    ctx.fillText(`${opts.count} ${opts.count === 1 ? "thing" : "things"} done this week`, 48, 118);
  }
  ctx.textAlign = "right";
  ctx.fillStyle = sub;
  ctx.font = '600 17px -apple-system, BlinkMacSystemFont, "SF Pro Text", system-ui, sans-serif';
  ctx.fillText("Built with Plucky", W - 32, H - 26);
  return c;
}

function ShareSheet({
  city,
  name,
  now,
  count,
  onClose,
  onError,
  onSaved,
}: {
  city: City;
  name: string;
  now: Date;
  count: number;
  onClose: () => void;
  onError: (e: unknown) => void;
  onSaved: (path: string) => void;
}) {
  const dark = useDark();
  const [showCount, setShowCount] = useState(true);
  const [names, setNames] = useState(false);
  const [copied, setCopied] = useState(false);
  // The picture is drawn in 3D like the city (flat where WebGL isn't available).
  const [canvas, setCanvas] = useState<HTMLCanvasElement | null>(null);
  useEffect(() => {
    let live = true;
    const opts = { count: showCount ? count : null, names, now, dark };
    if (!hasWebGL()) setCanvas(renderShareImage(city, name, opts));
    else
      import("./CityScene")
        .then((m) => live && setCanvas(m.renderCityPicture(city, name, opts)))
        .catch(() => live && setCanvas(renderShareImage(city, name, opts)));
    return () => {
      live = false;
    };
  }, [city, name, showCount, count, names, now, dark]);
  const preview = useMemo(() => canvas?.toDataURL("image/png") ?? null, [canvas]);
  const blob = () =>
    new Promise<Blob>((res, rej) =>
      canvas ? canvas.toBlob((b) => (b ? res(b) : rej(new Error("Couldn't make the picture."))), "image/png") : rej(new Error("The picture isn't ready yet.")),
    );

  async function copy() {
    try {
      const b = await blob();
      await navigator.clipboard.write([new ClipboardItem({ "image/png": b })]);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch (e) {
      onError(e);
    }
  }
  async function save() {
    try {
      const b = await blob();
      onSaved(await api.saveCityImage(name, new Uint8Array(await b.arrayBuffer())));
    } catch (e) {
      onError(e);
    }
  }

  return (
    <div className="share-sheet" onClick={onClose}>
      <div className="ss-card" role="dialog" aria-label="Share your city" onClick={(e) => e.stopPropagation()}>
        <div className="ss-head">
          <h2>Share your city</h2>
          <button type="button" className="cv-close" onClick={onClose} aria-label="Close">
            <svg width="12" height="12" viewBox="0 0 12 12" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden>
              <path d="M3 3l6 6M9 3l-6 6" />
            </svg>
          </button>
        </div>
        {preview ? <img className="ss-preview" src={preview} alt={`A picture of ${name}`} /> : <div className="ss-preview ss-wait" />}
        <label className="ss-opt">
          <input type="checkbox" checked={showCount} onChange={(e) => setShowCount(e.target.checked)} /> Show this week's count
        </label>
        <label className="ss-opt">
          <input type="checkbox" checked={names} onChange={(e) => setNames(e.target.checked)} /> Show project names on buildings
        </label>
        <p className="ss-note">Only this picture is shared. It's made on your Mac; no task names, notes or times are in it.</p>
        <div className="ss-actions">
          <button type="button" onClick={() => void copy()}>
            {copied ? "Copied" : "Copy image"}
          </button>
          <button type="button" className="primary" onClick={() => void save()}>
            Save to Downloads
          </button>
        </div>
      </div>
    </div>
  );
}

export function BuildingIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden>
      <path d="M2.5 14V6.5l4-2v9.5M6.5 14V2.5l7 2.5V14M1.5 14h13" strokeLinejoin="round" />
      <path d="M9 6.5h2M9 9h2M9 11.5h2" strokeLinecap="round" />
    </svg>
  );
}
function ShareIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden>
      <path d="M8 10V2.5M5 5.5l3-3 3 3M3.5 8.5v4a1 1 0 0 0 1 1h7a1 1 0 0 0 1-1v-4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
function ExpandIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden>
      <path d="M9.5 2.5h4v4M13.5 2.5 9 7M6.5 13.5h-4v-4M2.5 13.5 7 9" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
function PencilIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden>
      <path d="M11 2.5l2.5 2.5L6 12.5H3.5V10Z" strokeLinejoin="round" />
    </svg>
  );
}

export { MAIN_STREET };
