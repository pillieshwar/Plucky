import { useCallback, useEffect, useState, type ReactNode } from "react";
import { api, onCalendarChanged, onInboxChanged, onRemindersChanged, onWatchChanged } from "../lib/api";
import { Toggle } from "./GeneralSettings";
import { RemindersSection } from "./RemindersSection";
import { AgentsSection } from "./AgentsSection";
import { WatchSection } from "./WatchSection";
import { safeLocale } from "../lib/locale";
import type { AgentsStatus, WatchStatus, CalendarInfo, CalendarStatus, RemindersStatus } from "../lib/types";

/**
 * Connectors: apps on this Mac that TodoCity can work with. Each card shows
 * whether it's connected and opens to its settings. Everything goes through
 * macOS on this Mac; nothing signs in to a server. (Sync with your other Macs
 * passes end-to-end encrypted boxes through a relay that can't read them.)
 */
export function ConnectorsTab() {
  const [reminders, setReminders] = useState<RemindersStatus | null>(null);
  const [calendar, setCalendar] = useState<CalendarStatus | null>(null);
  const [agents, setAgents] = useState<AgentsStatus | null>(null);
  const [watch, setWatch] = useState<WatchStatus | null>(null);
  const [open, setOpen] = useState<Id | null>(null);

  const refresh = useCallback(() => {
    api.remindersStatus().then(setReminders).catch(() => undefined);
    api.calendarStatus().then(setCalendar).catch(() => undefined);
    api.agentsStatus().then(setAgents).catch(() => undefined);
    api.watchStatus().then(setWatch).catch(() => undefined);
  }, []);

  useEffect(() => {
    refresh();
    const subs = [onRemindersChanged(refresh), onCalendarChanged(refresh), onInboxChanged(refresh), onWatchChanged(refresh)];
    return () => subs.forEach((p) => void p.then((u) => u()));
  }, [refresh]);

  const toggle = (id: Id) => setOpen((o) => (o === id ? null : id));

  return (
    <div className="connectors">
      <ConnectorCard
        icon={<CalendarGlyph />}
        tone="calendar"
        name="Calendar"
        description="Your meetings beside your tasks."
        connected={!!calendar?.enabled && calendar.access === "full"}
        open={open === "calendar"}
        onToggle={() => toggle("calendar")}
      >
        <CalendarSection status={calendar} onStatus={setCalendar} />
      </ConnectorCard>

      <ConnectorCard
        icon={<RemindersGlyph />}
        tone="reminders"
        name="Apple Reminders"
        description="Sync both ways, and tick tasks off on your iPhone."
        connected={!!reminders?.enabled}
        open={open === "reminders"}
        onToggle={() => toggle("reminders")}
      >
        <RemindersSection embedded />
      </ConnectorCard>

      <ConnectorCard
        icon={<EyeGlyph />}
        tone="watch"
        name="Watch my screen"
        description="Spot to-dos in any app, on this Mac."
        connected={!!watch?.settings.enabled}
        connectedLabel="On"
        open={open === "watch"}
        onToggle={() => toggle("watch")}
      >
        <WatchSection locale={safeLocale()} />
      </ConnectorCard>

      <ConnectorCard
        icon={<SparkGlyph />}
        tone="agents"
        name="AI agents"
        description={agents?.full_access ? "AI apps work with your tasks: full access." : "Let AI apps add tasks for you to review."}
        connected={!!agents?.enabled}
        open={open === "agents"}
        onToggle={() => toggle("agents")}
      >
        <AgentsSection status={agents} onStatus={setAgents} />
      </ConnectorCard>

    </div>
  );
}

type Id = "reminders" | "calendar" | "agents" | "watch";

function ConnectorCard({
  icon,
  tone,
  name,
  description,
  connected,
  connectedLabel = "Connected",
  open,
  onToggle,
  children,
}: {
  icon: ReactNode;
  tone: string;
  name: string;
  description: string;
  connected: boolean;
  /** What "connected" means for this card, e.g. "On". */
  connectedLabel?: string;
  open: boolean;
  onToggle: () => void;
  children: ReactNode;
}) {
  return (
    <section className={open ? "connector open" : "connector"}>
      <div className="connector-head">
        <span className={`connector-icon ${tone}`} aria-hidden>
          {icon}
        </span>
        <div className="connector-text">
          <h3>{name}</h3>
          <p>{description}</p>
        </div>
        <button
          type="button"
          className={connected ? "connector-action connected" : "connector-action"}
          onClick={onToggle}
          aria-expanded={open}
        >
          {connected ? (
            <>
              <span className="connector-dot" aria-hidden /> {connectedLabel}
            </>
          ) : open ? (
            "Close"
          ) : (
            <>
              Connect <span aria-hidden>↗</span>
            </>
          )}
        </button>
      </div>
      {open && <div className="connector-body">{children}</div>}
    </section>
  );
}

/** Settings for the Calendar connector: on/off, permission, which calendars. */
function CalendarSection({
  status,
  onStatus,
}: {
  status: CalendarStatus | null;
  onStatus: (s: CalendarStatus) => void;
}) {
  const [calendars, setCalendars] = useState<CalendarInfo[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const access = status?.access;
  const loadCalendars = useCallback(() => {
    api
      .calendarCalendars()
      .then(setCalendars)
      .catch((e) => setError(String(e)));
  }, []);

  useEffect(() => {
    if (access !== "full") return;
    loadCalendars();
    // Subscribed calendars can finish loading later; list them when they do.
    const sub = onCalendarChanged(loadCalendars);
    return () => void sub.then((u) => u());
  }, [access, loadCalendars]);

  if (!status) return null;
  if (!status.supported) return <p className="setting-line muted">Calendar is available on macOS.</p>;

  const blocked = status.access === "denied" || status.access === "restricted" || status.access === "write_only";

  async function turnOn() {
    setError(null);
    setBusy(true);
    try {
      let a = status!.access;
      if (a === "not_determined") a = await api.calendarRequestAccess();
      if (a !== "full") {
        onStatus(await api.calendarStatus());
        return;
      }
      onStatus(await api.calendarSet(true, status!.hidden));
      loadCalendars();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  async function turnOff() {
    onStatus(await api.calendarSet(false, status!.hidden));
  }

  async function choose(key: string, on: boolean) {
    // Remember what's hidden, by name: new calendars show up by themselves,
    // and a calendar whose id macOS changes (Holidays does) stays as chosen.
    const hidden = status!.hidden.filter((k) => k !== key);
    onStatus(await api.calendarSet(true, on ? hidden : [...hidden, key]));
  }

  const enabled = status.enabled && status.access === "full";
  const shown = (key: string) => !status.hidden.includes(key);

  return (
    <div className="connector-body-inner">
      <div className="card-stack">
        <Toggle
          label="Show calendar events in TodoCity"
          hint="Meetings appear next to your tasks in the menu bar. Read-only — TodoCity never changes your calendar."
          checked={enabled}
          disabled={busy || blocked}
          onChange={(v) => void (v ? turnOn() : turnOff())}
        />
        {busy && <p className="setting-line muted">Waiting for permission…</p>}
        {blocked && (
          <div className="setting-line">
            <span className="dot warn" aria-hidden />
            <span className="setting-line-text">Calendar access is off for TodoCity.</span>
            <button type="button" className="ghost small" onClick={() => void api.calendarOpenPrivacySettings()}>
              Allow
            </button>
          </div>
        )}
        <div className="setting-line">
          <span className="dot ok" aria-hidden />
          <span className="setting-line-text muted">
            Includes Google, Outlook and iCloud calendars added to the Calendar app. Events stay on this Mac.
          </span>
        </div>
      </div>

      {enabled && calendars.length > 0 && (
        <>
          <h4 className="connector-subhead">Calendars to show</h4>
          <ul className="calendar-list">
            {calendars.map((c) => (
              <li key={c.key}>
                <label>
                  <input type="checkbox" checked={shown(c.key)} onChange={(e) => void choose(c.key, e.target.checked)} />
                  <span className="calendar-swatch" style={{ background: c.color ?? "var(--faint)" }} aria-hidden />
                  <span className="calendar-name">{c.title}</span>
                  <span className="calendar-source">{c.source}</span>
                </label>
              </li>
            ))}
          </ul>
        </>
      )}
      {error && <p className="rem-error">{error}</p>}
    </div>
  );
}

function EyeGlyph() {
  return (
    <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6">
      <path d="M2.5 10s2.8-5 7.5-5 7.5 5 7.5 5-2.8 5-7.5 5-7.5-5-7.5-5Z" strokeLinejoin="round" />
      <circle cx="10" cy="10" r="2.2" />
    </svg>
  );
}

function SparkGlyph() {
  return (
    <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round">
      <path d="M10 2.5 11.6 8.4 17.5 10l-5.9 1.6L10 17.5l-1.6-5.9L2.5 10l5.9-1.6Z" />
      <path d="M15.5 2.5v3M14 4h3" strokeLinecap="round" />
    </svg>
  );
}

function CalendarGlyph() {
  return (
    <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6">
      <rect x="3" y="4.5" width="14" height="12.5" rx="2.5" />
      <path d="M3 8.5h14M7 2.75v3.5M13 2.75v3.5" strokeLinecap="round" />
      <circle cx="7.5" cy="12" r="0.9" fill="currentColor" stroke="none" />
      <circle cx="10" cy="12" r="0.9" fill="currentColor" stroke="none" />
      <circle cx="12.5" cy="12" r="0.9" fill="currentColor" stroke="none" />
    </svg>
  );
}

function RemindersGlyph() {
  return (
    <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6">
      <circle cx="5" cy="5.5" r="1.6" />
      <circle cx="5" cy="10" r="1.6" />
      <circle cx="5" cy="14.5" r="1.6" />
      <path d="M9 5.5h7.5M9 10h7.5M9 14.5h7.5" strokeLinecap="round" />
    </svg>
  );
}
