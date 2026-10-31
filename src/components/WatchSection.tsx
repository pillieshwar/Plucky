import { useCallback, useEffect, useState } from "react";
import { api, onWatchChanged } from "../lib/api";
import { timeLabel } from "../lib/schedule";
import type { WatchStatus } from "../lib/types";
import { Toggle } from "./GeneralSettings";
import { InfoTip } from "./InfoTip";
import { AgentTile } from "./AgentPanel";

function hhmm(at: string, locale: string): string {
  return timeLabel(at.slice(11, 16), locale);
}

const LOCAL = "local";

/** What watching is doing right now, in words, and the button that helps. */
function liveLine(s: WatchStatus, locale: string, readerName: string): { tone: "ok" | "warn" | "muted"; text: string; fix?: "access" | "agents" | "models" } {
  const { state, current } = s.live;
  switch (state) {
    case "watching":
      return { tone: "ok", text: current ? `Watching ${current}` : "On" };
    case "paused":
      return { tone: "muted", text: s.settings.paused_until ? `Paused until ${hhmm(s.settings.paused_until, locale)}` : "Paused" };
    case "on_battery":
      return { tone: "muted", text: "Starts when your Mac is plugged in" };
    case "no_model":
      return { tone: "warn", text: "Add an open model, or send to an agent", fix: "models" };
    case "no_agent":
      return { tone: "warn", text: `Connect ${readerName} to start`, fix: "agents" };
    case "no_access":
      return { tone: "warn", text: "Allow Accessibility to start", fix: "access" };
    case "unsupported":
      return { tone: "muted", text: "Available on macOS" };
    default:
      return { tone: "muted", text: "Off" };
  }
}

/**
 * Settings → Watch: off until the person turns it on. It reads new text in
 * the app in front and suggests to-dos, through the reader they pick: an
 * agent they already use (sent to its AI service) or the open model on this
 * Mac.
 */
export function WatchSection({ locale, onAgents, onModels }: { locale: string; onAgents?: () => void; onModels?: () => void }) {
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
  if (!status.supported) return <p className="setting-line muted">Watch is available on macOS.</p>;
  const s = status.settings;
  const always = new Set(status.always_skipped.map(([b]) => b));
  const readers = status.readers ?? [];
  const connected = readers.filter((r) => r.connected);
  const picked = readers.find((r) => r.id === s.reader);
  const readerName = s.reader === LOCAL ? "the open model" : (picked?.name ?? "the agent");

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
          reader: next.reader,
        }),
      );
    } catch (e) {
      setError(String(e));
    }
  }

  function setSkipped(bundle: string, skip: boolean) {
    void save({ excluded: skip ? [...s.excluded.filter((b) => b !== bundle), bundle] : s.excluded.filter((b) => b !== bundle) });
  }

  const live = liveLine(status, locale, readerName);
  const look = status.live.last_look;
  const recent = status.live.recent.filter((r) => !always.has(r.bundle));
  const otherExcluded = s.excluded.filter((b) => !recent.some((r) => r.bundle === b));
  const sendInfo =
    s.reader === LOCAL
      ? "Read by the open model on this Mac."
      : `New messages that look like to-dos go to ${readerName}, signed in as you, and from it to its AI service. At most 40 checks an hour.`;

  return (
    <section className="settings-section watch-page">
      <div className="card-stack">
        <Toggle
          label="Watch my screen"
          info="Spots requests, deadlines and your own promises in the app in front, and suggests them as tasks for you to approve. No screenshots or recording; never what you type or password fields."
          checked={s.enabled}
          onChange={(v) => void save({ enabled: v })}
        />
        <div className="toggle-row watch-send">
          <span className="toggle-text">
            <span className="toggle-label">
              Send to
              <InfoTip text={sendInfo} label="About where Watch sends" />
            </span>
          </span>
          <span className="watch-reader">
            {s.reader !== LOCAL && <AgentTile agent={s.reader} size={20} />}
            <select aria-label="Send to" value={s.reader} onChange={(e) => void save({ reader: e.target.value })}>
              {connected.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name}
                </option>
              ))}
              {picked && !picked.connected && <option value={picked.id}>{picked.name} (connect in Agents)</option>}
              <option value={LOCAL}>Open model on this Mac</option>
            </select>
          </span>
        </div>
        {connected.length === 0 && (
          <div className="setting-line">
            <span className="setting-line-text muted">Connect an agent to send Watch to it.</span>
            <button type="button" className="ghost small" onClick={onAgents}>
              Agents
            </button>
          </div>
        )}
      </div>

      {s.enabled && (
        <div className="setting-line">
          <span className={`dot ${live.tone === "ok" ? "ok" : live.tone === "warn" ? "warn" : ""}`} aria-hidden />
          <span className={live.tone === "muted" ? "setting-line-text muted" : "setting-line-text"}>{live.text}</span>
          {look && (
            <InfoTip
              label="About the last look"
              text={`Last look at ${look.app}, ${timeLabel(look.at.slice(0, 5), locale)}: ${look.lines} lines, ${look.new} new${look.asked ? `, ${look.found} found` : ""} — ${look.step}.`}
            />
          )}
          {live.fix === "access" && (
            <button type="button" className="ghost small" onClick={() => void api.requestAccessibility()}>
              Allow
            </button>
          )}
          {live.fix === "agents" && (
            <button type="button" className="ghost small" onClick={onAgents}>
              Agents
            </button>
          )}
          {live.fix === "models" && (
            <button type="button" className="ghost small" onClick={onModels}>
              Open models
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

      {s.enabled && (
        <>
          <div className="card-stack">
            <NameRow
              value={s.names["*"] ?? ""}
              placeholder={status.default_name ?? "Your name"}
              onSave={(v) => void save({ names: { ...s.names, "*": v } })}
            />
            <Toggle
              label="Show suggestions right away"
              info="Opens the menu-bar dropdown when a to-do is spotted. Off: they wait quietly behind the banner."
              checked={s.show_right_away}
              onChange={(v) => void save({ show_right_away: v })}
            />
            <Toggle
              label="Only when plugged in"
              info="Saves battery."
              checked={s.plugged_in_only}
              onChange={(v) => void save({ plugged_in_only: v })}
            />
          </div>

          <h3 className="set-subhead">
            Apps
            <InfoTip text="Never read: password managers, Keychain, System Settings, terminals and TodoCity. Skip any other app here." />
          </h3>
          {recent.length > 0 || otherExcluded.length > 0 ? (
            <ul className="watch-apps">
              {recent.map((r) => {
                const off = s.excluded.includes(r.bundle);
                return (
                  <li key={r.bundle}>
                    <span className={off ? "watch-app off" : "watch-app"}>{r.name}</span>
                    <button type="button" className="link-btn quiet" onClick={() => setSkipped(r.bundle, !off)}>
                      {off ? "Watch again" : "Skip"}
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
            <p className="setting-line muted">Apps you use show up here.</p>
          )}
        </>
      )}
      {error && <p className="rem-error">{error}</p>}
    </section>
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
        <span className="toggle-label">
          Your name
          <InfoTip text="So your own promises (“I'll send it Monday”) count and other people's don't. Add other forms with semicolons, like “Rivera, Sam; sam@company.com”." />
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
