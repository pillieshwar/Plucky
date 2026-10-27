import { useCallback, useEffect, useState } from "react";
import { api, onEmailTasksChanged } from "../lib/api";
import { timeLabel } from "../lib/schedule";
import type { EmailTasksStatus } from "../lib/types";
import { Toggle } from "./GeneralSettings";

const INTERVALS = [15, 30, 60];

/** "2:30 PM" today, "Thu 2:30 PM" otherwise. */
function when(at: string, locale: string): string {
  const d = new Date(at);
  if (Number.isNaN(d.getTime())) return at;
  const time = timeLabel(`${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`, locale);
  return d.toDateString() === new Date().toDateString()
    ? time
    : `${d.toLocaleDateString(locale, { weekday: "short" })} ${time}`;
}

/**
 * Connectors → AI agents → Email to tasks: TodoCity runs Claude Code's
 * /email-tasks on a schedule; Claude Code reads the mail, TodoCity only gets
 * the tasks.
 */
export function EmailTasksSection({ locale }: { locale: string }) {
  const [status, setStatus] = useState<EmailTasksStatus | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(() => {
    api.emailTasksStatus().then(setStatus).catch(() => undefined);
  }, []);

  useEffect(() => {
    refresh();
    const sub = onEmailTasksChanged(refresh);
    return () => void sub.then((u) => u());
  }, [refresh]);

  if (!status) return null;
  const s = status.schedule;

  async function save(change: Partial<typeof s>) {
    setError(null);
    const next = { ...s, ...change };
    try {
      setStatus(
        await api.emailTasksSet({
          enabled: next.enabled,
          start: next.start,
          end: next.end,
          interval: next.interval,
          weekdays_only: next.weekdays_only,
          server: next.server,
        }),
      );
    } catch (e) {
      setError(String(e));
    }
  }

  async function runNow() {
    setError(null);
    setStatus({ ...status!, running: true });
    try {
      setStatus(await api.emailTasksRunNow());
    } catch (e) {
      setError(String(e));
    }
  }

  const mailServers = status.servers;
  const server = s.server ?? "";
  const ready = status.claude_code_connected && !!server;

  return (
    <div className="email-tasks">
      <h4 className="connector-subhead">Email to tasks</h4>
      {!status.claude_code_connected ? (
        <p className="setting-line muted">Connect Claude Code above to have it check your email for to-dos.</p>
      ) : (
        <>
          <div className="card-stack">
            <Toggle
              label="Check my email for to-dos"
              hint="Claude Code reads new email with your mail connection and sends what you need to do here for review. TodoCity never reads your mail."
              checked={s.enabled}
              disabled={!server}
              onChange={(v) => void save({ enabled: v })}
            />
            <label className="toggle-row">
              <span className="toggle-text">
                <span className="toggle-label">Mail connection</span>
                <span className="toggle-hint">
                  {mailServers.length
                    ? "The Outlook or Exchange MCP server you added to Claude Code."
                    : "Add your company's Outlook or Exchange MCP server to Claude Code first."}
                </span>
              </span>
              {mailServers.length > 0 ? (
                <select
                  className="email-select"
                  value={server}
                  onChange={(e) => void save({ server: e.target.value || null })}
                >
                  <option value="">Choose…</option>
                  {mailServers.map((n) => (
                    <option key={n} value={n}>
                      {n}
                    </option>
                  ))}
                </select>
              ) : (
                <button type="button" className="ghost small" onClick={refresh}>
                  Look again
                </button>
              )}
            </label>
            <div className={s.enabled ? "toggle-row email-when-row" : "toggle-row email-when-row disabled"}>
              <span className="toggle-text">
                <span className="toggle-label">When</span>
                <span className="toggle-hint">Your local time, while TodoCity is running.</span>
              </span>
              <span className="email-when">
                <select
                  className="email-select"
                  value={s.interval}
                  disabled={!s.enabled}
                  aria-label="How often"
                  onChange={(e) => void save({ interval: Number(e.target.value) })}
                >
                  {INTERVALS.map((m) => (
                    <option key={m} value={m}>
                      every {m === 60 ? "hour" : `${m} min`}
                    </option>
                  ))}
                </select>
                <input
                  type="time"
                  className="time-input"
                  value={s.start}
                  disabled={!s.enabled}
                  aria-label="From"
                  onChange={(e) => e.target.value && void save({ start: e.target.value })}
                />
                <span aria-hidden>–</span>
                <input
                  type="time"
                  className="time-input"
                  value={s.end}
                  disabled={!s.enabled}
                  aria-label="Until"
                  onChange={(e) => e.target.value && void save({ end: e.target.value })}
                />
              </span>
            </div>
            <Toggle
              label="Weekdays only"
              checked={s.weekdays_only}
              disabled={!s.enabled}
              onChange={(v) => void save({ weekdays_only: v })}
            />
          </div>
          <div className="agent-test">
            <button type="button" className="ghost small" disabled={!ready || status.running} onClick={() => void runNow()}>
              {status.running ? "Checking…" : "Check now"}
            </button>
            <span
              className={
                status.running || !s.last ? "agent-test-result" : s.last.ok ? "agent-test-result ok" : "agent-test-result error"
              }
            >
              {status.running
                ? "Claude Code is reading your email…"
                : s.last
                  ? `${when(s.last.at, locale)} · ${s.last.message}`
                  : "Not checked yet."}
            </span>
          </div>
        </>
      )}
      {error && <p className="rem-error">{error}</p>}
    </div>
  );
}
