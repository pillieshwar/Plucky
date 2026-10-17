import { useCallback, useEffect, useState } from "react";
import { api, onWatchChanged } from "../lib/api";
import { timeLabel } from "../lib/schedule";
import type { WatchStatus } from "../lib/types";
import { Toggle } from "./GeneralSettings";

function hhmm(at: string, locale: string): string {
  return timeLabel(at.slice(11, 16), locale);
}

/** What watch mode is doing right now, in words. */
function liveLine(s: WatchStatus, locale: string): { tone: "ok" | "warn" | "muted"; text: string } {
  const { state, current } = s.live;
  switch (state) {
    case "watching":
      return current
        ? { tone: "ok", text: `Watching ${current} for new to-dos.` }
        : { tone: "ok", text: "On — watching whenever Slack or Outlook is in front." };
    case "paused":
      return {
        tone: "muted",
        text: s.settings.paused_until ? `Paused until ${hhmm(s.settings.paused_until, locale)}.` : "Paused.",
      };
    case "on_battery":
      return { tone: "muted", text: "Waiting for power — you chose to watch only when plugged in." };
    case "no_model":
      return { tone: "warn", text: "Download a model in the Models tab first; it reads the messages on this Mac." };
    case "no_access":
      return { tone: "warn", text: "Plucky needs Accessibility access (the same as the capture shortcut)." };
    case "unsupported":
      return { tone: "muted", text: "Watching is available on macOS." };
    default:
      return { tone: "muted", text: "Off." };
  }
}

/**
 * Connectors → Watch for to-dos: notice requests and deadlines in Slack and
 * Outlook as they appear, read through Accessibility on this Mac.
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

  async function save(change: Partial<typeof s>) {
    setError(null);
    const next = { ...s, ...change };
    try {
      setStatus(
        await api.watchSet({
          enabled: next.enabled,
          apps: next.apps,
          plugged_in_only: next.plugged_in_only,
          show_right_away: next.show_right_away,
        }),
      );
    } catch (e) {
      setError(String(e));
    }
  }

  function toggleApp(bundle: string, on: boolean) {
    void save({ apps: on ? [...s.apps.filter((a) => a !== bundle), bundle] : s.apps.filter((a) => a !== bundle) });
  }

  const live = liveLine(status, locale);

  return (
    <div className="connector-body-inner">
      <div className="card-stack">
        <Toggle
          label="Watch for to-dos"
          hint="When Slack or Outlook is in front, Plucky reads new messages on this Mac and suggests the ones that ask something of you. You approve each one."
          checked={s.enabled}
          onChange={(v) => void save({ enabled: v })}
        />
        {s.enabled && (
          <div className="setting-line">
            <span className={`dot ${live.tone === "ok" ? "ok" : live.tone === "warn" ? "warn" : ""}`} aria-hidden />
            <span className={live.tone === "muted" ? "setting-line-text muted" : "setting-line-text"}>{live.text}</span>
            {live.tone === "warn" && status.live.state === "no_access" && (
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

      {s.enabled && status.model?.startsWith("llama-3.2") && (
        <div className="setting-line">
          <span className="dot warn" aria-hidden />
          <span className="setting-line-text">
            Your model suggests many false to-dos when watching. Qwen3.5 4B is quieter and faster — get it in the
            Models tab.
          </span>
          <button type="button" className="ghost small" onClick={() => void api.openMain(null, "models")}>
            Models
          </button>
        </div>
      )}

      {s.enabled && (
        <>
          <h4 className="connector-subhead">Apps</h4>
          <ul className="calendar-list">
            {status.apps.map((a) => (
              <li key={a.bundle}>
                <label>
                  <input
                    type="checkbox"
                    checked={s.apps.includes(a.bundle)}
                    onChange={(e) => toggleApp(a.bundle, e.target.checked)}
                  />
                  <span className="calendar-name">{a.name}</span>
                  <span className="calendar-source">{a.installed ? "" : "not installed"}</span>
                </label>
              </li>
            ))}
          </ul>
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
          No screenshots or recording. Plucky reads the text of the window in front — never what you type or password
          fields — keeps none of it, and nothing leaves this Mac.
        </span>
      </div>
      {error && <p className="rem-error">{error}</p>}
    </div>
  );
}
