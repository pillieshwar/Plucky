import { useCallback, useEffect, useState } from "react";
import { api, onWatchChanged } from "../lib/api";
import { timeLabel } from "../lib/schedule";
import type { WatchStatus } from "../lib/types";
import { Toggle } from "./GeneralSettings";

function hhmm(at: string, locale: string): string {
  return timeLabel(at.slice(11, 16), locale);
}

/** What watching is doing right now, in words. */
function liveLine(s: WatchStatus, locale: string): { tone: "ok" | "warn" | "muted"; text: string } {
  const { state, current } = s.live;
  switch (state) {
    case "watching":
      return current
        ? { tone: "ok", text: `Watching ${current} for new to-dos.` }
        : { tone: "ok", text: "On — watching whichever app is in front." };
    case "paused":
      return {
        tone: "muted",
        text: s.settings.paused_until ? `Paused until ${hhmm(s.settings.paused_until, locale)}.` : "Paused.",
      };
    case "on_battery":
      return { tone: "muted", text: "Starts again when your Mac is plugged in." };
    case "no_model":
      return { tone: "warn", text: "Add the AI model in Settings → AI model to start watching. It runs on this Mac." };
    case "no_access":
      return { tone: "warn", text: "Allow Accessibility to start watching — the same permission as the capture shortcut." };
    case "unsupported":
      return { tone: "muted", text: "Watching is available on macOS." };
    default:
      return { tone: "muted", text: "Off." };
  }
}

/**
 * Connectors → Watch my screen: notice requests, assignments and deadlines
 * in whatever app is in front, read through Accessibility on this Mac.
 */
export function WatchSection({ locale }: { locale: string }) {
  const [status, setStatus] = useState<WatchStatus | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(() => {
    api.watchStatus().then(setStatus).catch(() => undefined);
  }, []);

  useEffect(() => {
    refresh();
    const sub = onWatchChanged(refresh);
    return () => void sub.then((u) => u());
  }, [refresh]);

  if (!status) return null;
  if (!status.supported) return <p className="setting-line muted">Watching is available on macOS.</p>;
  const s = status.settings;
  const always = new Set(status.always_skipped.map(([b]) => b));

  async function save(change: Partial<typeof s>) {
    setError(null);
    const next = { ...s, ...change };
    try {
      setStatus(
        await api.watchSet({
          enabled: next.enabled,
          excluded: next.excluded,
          plugged_in_only: next.plugged_in_only,
          show_right_away: next.show_right_away,
          names: next.names,
        }),
      );
    } catch (e) {
      setError(String(e));
    }
  }

  function setSkipped(bundle: string, skip: boolean) {
    void save({ excluded: skip ? [...s.excluded.filter((b) => b !== bundle), bundle] : s.excluded.filter((b) => b !== bundle) });
  }

  const live = liveLine(status, locale);
  const look = status.live.last_look;
  const recent = status.live.recent.filter((r) => !always.has(r.bundle));
  // Excluded apps not in the recent list still need a way back.
  const otherExcluded = s.excluded.filter((b) => !recent.some((r) => r.bundle === b));

  return (
    <div className="connector-body-inner">
      <div className="card-stack">
        <Toggle
          label="Watch my screen for to-dos"
          hint="Whatever app is in front, TodoCity reads new text on this Mac and suggests what asks something of you — requests, assignments, deadlines, your own promises. You approve each one."
          checked={s.enabled}
          onChange={(v) => void save({ enabled: v })}
        />
        {s.enabled && (
          <div className="setting-line">
            <span className={`dot ${live.tone === "ok" ? "ok" : live.tone === "warn" ? "warn" : ""}`} aria-hidden />
            <span className={live.tone === "muted" ? "setting-line-text muted" : "setting-line-text"}>{live.text}</span>
            {status.live.state === "no_access" && (
              <button type="button" className="ghost small" onClick={() => void api.requestAccessibility()}>
                Allow
              </button>
            )}
            {status.live.state === "paused" ? (
              <button type="button" className="ghost small" onClick={() => void api.watchPause(0).then(setStatus)}>
                Resume
              </button>
            ) : status.live.state === "watching" ? (
              <button type="button" className="ghost small" onClick={() => void api.watchPause(60).then(setStatus)}>
                Pause 1 hour
              </button>
            ) : null}
          </div>
        )}
      </div>

      {s.enabled && look && (
        <p className="watch-look" aria-live="polite">
          Last look at {look.app}, {timeLabel(look.at.slice(0, 5), locale)}: {look.lines} lines read · {look.new} new
          {look.asked ? ` · model found ${look.found}` : ""} — {look.step}.
        </p>
      )}

      {s.enabled && (
        <>
          <h4 className="connector-subhead">Your name</h4>
          <div className="card-stack">
            <NameRow
              value={s.names["*"] ?? ""}
              placeholder={status.default_name ?? "Your name"}
              onSave={(v) => void save({ names: { ...s.names, "*": v } })}
            />
          </div>

          <h4 className="connector-subhead">Apps</h4>
          <p className="setting-line muted">
            Every app is watched except these, which are never read: password managers, Keychain, System Settings,
            terminals and TodoCity. Skip any other app below.
          </p>
          {recent.length > 0 || otherExcluded.length > 0 ? (
            <ul className="watch-apps">
              {recent.map((r) => {
                const off = s.excluded.includes(r.bundle);
                return (
                  <li key={r.bundle}>
                    <span className={off ? "watch-app off" : "watch-app"}>{r.name}</span>
                    <button type="button" className="link-btn quiet" onClick={() => setSkipped(r.bundle, !off)}>
                      {off ? "Watch again" : "Skip this app"}
                    </button>
                  </li>
                );
              })}
              {otherExcluded.map((b) => (
                <li key={b}>
                  <span className="watch-app off">{b}</span>
                  <button type="button" className="link-btn quiet" onClick={() => setSkipped(b, false)}>
                    Watch again
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="setting-line muted">Apps you use will show up here, so you can skip any of them.</p>
          )}

          <div className="card-stack">
            <Toggle
              label="Show suggestions right away"
              hint="Open the menu-bar dropdown when a to-do is noticed. Off: they wait quietly behind the banner."
              checked={s.show_right_away}
              onChange={(v) => void save({ show_right_away: v })}
            />
            <Toggle
              label="Only when plugged in"
              hint="Saves battery: the model only runs on power."
              checked={s.plugged_in_only}
              onChange={(v) => void save({ plugged_in_only: v })}
            />
          </div>
        </>
      )}

      <div className="setting-line">
        <span className="dot ok" aria-hidden />
        <span className="setting-line-text muted">
          No screenshots or recording. TodoCity reads the text of the window in front — never what you type or password
          fields — keeps none of it, and nothing leaves this Mac.
        </span>
      </div>
      {error && <p className="rem-error">{error}</p>}
    </div>
  );
}

/** "Your name": saved when the field loses focus or on Return. */
function NameRow({ value, placeholder, onSave }: { value: string; placeholder: string; onSave: (value: string) => void }) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  const commit = () => {
    if (draft.trim() !== value.trim()) onSave(draft.trim());
  };
  return (
    <label className="toggle-row name-row">
      <span className="toggle-text">
        <span className="toggle-label">How apps show your name</span>
        <span className="toggle-hint">
          So your own promises (“I'll send it Monday”) count and other people's don't. Add other forms with
          semicolons, e.g. “Rivera, Sam; sam@company.com”.
        </span>
      </span>
      <input
        className="name-input"
        value={draft}
        placeholder={placeholder}
        maxLength={200}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            commit();
          }
        }}
      />
    </label>
  );
}
