import { useEffect, useMemo, useRef, useState, type ReactElement } from "react";
import { cityStats, type City } from "../lib/city";
import type { UpdateStatus } from "../lib/types";
import { api } from "../lib/api";
import { VersionDot } from "./VersionDot";

const REPO = "https://github.com/pillieshwar/TodoCity";

function GitHubIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="currentColor" aria-hidden>
      <path d="M8 .2a8 8 0 0 0-2.53 15.59c.4.07.55-.17.55-.38v-1.33c-2.23.48-2.7-1.07-2.7-1.07-.36-.92-.89-1.17-.89-1.17-.73-.5.05-.49.05-.49.8.06 1.23.83 1.23.83.72 1.22 1.88.87 2.33.66.07-.52.28-.87.5-1.07-1.78-.2-3.65-.89-3.65-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82a7.6 7.6 0 0 1 4 0c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.28.82 2.15 0 3.07-1.87 3.75-3.66 3.95.29.25.54.73.54 1.48v2.2c0 .21.15.46.55.38A8 8 0 0 0 8 .2Z" />
    </svg>
  );
}

/**
 * Full screen's footer: the model reading captures on the left, a small
 * skyline of your city in the middle (it glows when someone moves in), and
 * the version on the right — green when it's the latest, red when there's
 * a newer one to update to.
 */
export function FullFooter({
  model,
  captureHint,
  onModel,
  city,
  cityName,
  showCity,
  onCity,
  now,
  version,
  update,
  onError,
}: {
  model: string | null;
  captureHint: ReactElement;
  onModel: () => void;
  city: City;
  cityName: string | null;
  showCity: boolean;
  onCity: () => void;
  now: Date;
  version: string | null;
  update: UpdateStatus;
  onError: (message: string) => void;
}) {
  const stats = useMemo(() => cityStats(city, "week", now), [city, now]);
  // The tallest few buildings, as a tiny skyline: lit from the ground up as their homes fill.
  const skyline = useMemo(() => {
    const real = city.buildings.filter((b) => b.kind !== "plots");
    const sized = real
      .map((b) => {
        const rooms = b.floors.reduce((n, f) => n + f.rooms.length, 0);
        const lit = b.floors.reduce((n, f) => n + f.rooms.filter((r) => r.lit).length, 0);
        return { key: b.key, rooms, lit };
      })
      .sort((a, b) => b.rooms - a.rooms)
      .slice(0, 9);
    const max = Math.max(1, ...sized.map((s) => s.rooms));
    // Tallest in the middle, like a downtown.
    const order: typeof sized = [];
    sized.forEach((s, i) => (i % 2 ? order.push(s) : order.unshift(s)));
    return order.map((s) => ({ key: s.key, h: 6 + Math.round((12 * s.rooms) / max), lit: s.rooms ? s.lit / s.rooms : 0 }));
  }, [city]);
  // A soft glow when a window lights up while you watch.
  const [pulse, setPulse] = useState(false);
  const last = useRef(city.total);
  useEffect(() => {
    if (last.current > 0 && city.total > last.current) {
      setPulse(true);
      const t = window.setTimeout(() => setPulse(false), 1400);
      last.current = city.total;
      return () => window.clearTimeout(t);
    }
    last.current = city.total;
  }, [city.total]);

  return (
    <footer className="full-foot" aria-label="Status">
      <div className="ff-left">
        <button type="button" className="ff-model" onClick={onModel} title="Settings → AI model">
          <span className="local-dot" aria-hidden />
          <span className="ff-strong">On this Mac</span>
          <span>· {model ?? "No model yet"}</span>
        </button>
        <span className="ff-hint">{captureHint}</span>
      </div>
      {showCity ? (
        <button type="button" className={pulse ? "ff-city lit-up" : "ff-city"} onClick={onCity} title="Open your city">
          <span className="ff-sky" aria-hidden>
            {skyline.map((b) => (
              <span key={b.key} className="ff-tower" style={{ height: b.h }}>
                <span className="ff-lit" style={{ height: `${Math.round(b.lit * 100)}%` }} />
              </span>
            ))}
          </span>
          <span className="ff-strong">{cityName ?? "Your city"}</span>
          <span>{city.total}</span>
          {stats.today > 0 && <span className="ff-today">+{stats.today} today</span>}
        </button>
      ) : (
        <span />
      )}
      <div className="ff-right">
        <button
          type="button"
          className="ff-star"
          onClick={() => void api.openUrl(REPO).catch((e) => onError(String(e)))}
          title="TodoCity on GitHub"
        >
          <GitHubIcon /> Star us
        </button>
        <VersionDot update={update} version={version} onError={onError} />
      </div>
    </footer>
  );
}
