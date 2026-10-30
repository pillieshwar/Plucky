import { useCallback, useEffect, useMemo, useState } from "react";
import { api, onCalendarSyncChanged } from "../lib/api";
import type { CalendarLane, CalendarSyncStatus } from "../lib/types";
import { Toggle } from "./GeneralSettings";

/** "2 min ago", "just now". */
function ago(stamp: string | null, now = new Date()): string | null {
  if (!stamp) return null;
  const mins = Math.round((now.getTime() - new Date(stamp).getTime()) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min ago`;
  const h = Math.round(mins / 60);
  return h < 24 ? `${h} hr ago` : new Date(stamp).toLocaleDateString();
}

/** Lanes by group (Work, Personal…), in the order they come. */
export function byGroup(lanes: CalendarLane[]): { group: string; lanes: CalendarLane[] }[] {
  const out: { group: string; lanes: CalendarLane[] }[] = [];
  for (const l of lanes) {
    const g = out.find((x) => x.group === l.group);
    if (g) g.lanes.push(l);
    else out.push({ group: l.group, lanes: [l] });
  }
  return out;
}

/**
 * Apple Calendar → "Put your tasks in Calendar": timed tasks become events,
 * both ways, in calendars of their own (one per project, grouped by Work and
 * Personal) inside the account the user picks — never the default calendar.
 */
export function CalendarSyncSection() {
  const [status, setStatus] = useState<CalendarSyncStatus | null>(null);
  const [source, setSource] = useState<string>("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(() => {
    api
      .calsyncStatus()
      .then((s) => {
        setStatus(s);
        setSource((cur) => cur || s.source || s.sources[0]?.id || "");
      })
      .catch(() => undefined);
  }, []);
  useEffect(() => {
    refresh();
    const sub = onCalendarSyncChanged(refresh);
    return () => void sub.then((u) => u());
  }, [refresh]);

  const groups = useMemo(() => byGroup(status?.lanes ?? []), [status]);
  if (!status || !status.supported) return null;

  async function run(action: () => Promise<CalendarSyncStatus>) {
    setError(null);
    setBusy(true);
    try {
      setStatus(await action());
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  const chosen = status.sources.find((s) => s.id === (status.source ?? source));
  const when = ago(status.last_sync);

  return (
    <div className="calsync">
      <h4 className="connector-subhead">Your tasks in Calendar</h4>
      <div className="card-stack">
        <Toggle
          label="Put my tasks in Calendar"
          hint="Tasks with a day and time show as events, and stay in step both ways: move or stretch an event and the task follows; delete it and the task goes too. They get calendars of their own — never your default calendar."
          checked={status.enabled}
          disabled={busy || (!status.enabled && (status.access !== "full" || !source))}
          onChange={(v) => void run(() => (v ? api.calsyncAppleEnable(source) : api.calsyncAppleDisable(true)))}
        />
        {!status.enabled && status.access !== "full" && (
          <div className="setting-line">
            <span className="dot warn" aria-hidden />
            <span className="setting-line-text">Allow TodoCity to use Calendar first.</span>
            <button
              type="button"
              className="ghost small"
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  const a = await api.calendarRequestAccess();
                  if (a !== "full") await api.calendarOpenPrivacySettings();
                  return api.calsyncStatus();
                })
              }
            >
              Allow
            </button>
          </div>
        )}
        {!status.enabled && status.sources.length > 0 && (
          <label className="toggle-row">
            <span className="toggle-text">
              <span className="toggle-label">Keep them in</span>
              <span className="toggle-hint">iCloud shows them on your iPhone too; On My Mac keeps them here.</span>
            </span>
            <select className="email-select" value={source} onChange={(e) => setSource(e.target.value)} aria-label="Account for TodoCity's calendars">
              {status.sources.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.title}
                </option>
              ))}
            </select>
          </label>
        )}
        {status.enabled && (
          <div className="setting-line">
            <span className={status.last_error ? "dot warn" : "dot ok"} aria-hidden />
            <span className="setting-line-text">
              {status.last_error ??
                `In ${chosen?.title ?? "Calendar"} · ${status.synced} ${status.synced === 1 ? "calendar" : "calendars"}${when ? ` · synced ${when}` : ""}`}
            </span>
            <button type="button" className="ghost small" disabled={busy} onClick={() => void run(api.calsyncSyncNow)}>
              Sync now
            </button>
          </div>
        )}
      </div>

      {status.enabled && (
        <>
          <p className="calsync-lead">
            In Calendar they appear as <strong>TodoCity · Work · Launch</strong> and so on — tick them there to show or hide each one. Choose here which
            ones TodoCity keeps in Calendar; new projects are added by themselves.
          </p>
          {groups.map((g) => {
            const all = g.lanes.every((l) => l.on);
            const some = g.lanes.some((l) => l.on);
            return (
              <div key={g.group} className="calsync-group">
                <label className="calsync-group-row">
                  <input
                    type="checkbox"
                    checked={all}
                    ref={(el) => {
                      if (el) el.indeterminate = some && !all;
                    }}
                    onChange={(e) => void run(() => api.calsyncSetGroup(g.group, e.target.checked))}
                    aria-label={`Sync every ${g.group} project`}
                  />
                  <span className="calsync-group-name">TodoCity · {g.group}</span>
                </label>
                <ul className="calendar-list calsync-lanes">
                  {g.lanes.map((l) => (
                    <li key={l.key}>
                      <label>
                        <input type="checkbox" checked={l.on} onChange={(e) => void run(() => api.calsyncSetLane(l.key, e.target.checked))} />
                        <span className="calendar-name">{l.name}</span>
                      </label>
                    </li>
                  ))}
                </ul>
              </div>
            );
          })}
        </>
      )}
      {error && <p className="setting-line error-text">{error}</p>}
    </div>
  );
}
