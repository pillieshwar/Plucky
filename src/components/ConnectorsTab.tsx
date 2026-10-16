import { useCallback, useEffect, useState, type ReactNode } from "react";
import { api, onCalendarChanged, onInboxChanged, onRemindersChanged, onSlackChanged } from "../lib/api";
import { Toggle } from "./GeneralSettings";
import { RemindersSection } from "./RemindersSection";
import type { AgentsStatus, CalendarInfo, CalendarStatus, RemindersStatus, SlackStatus } from "../lib/types";

/**
 * Connectors: apps on this Mac that Plucky can work with. Each card shows
 * whether it's connected and opens to its settings. Everything goes through
 * macOS on this Mac; nothing signs in to a server.
 */
export function ConnectorsTab() {
  const [reminders, setReminders] = useState<RemindersStatus | null>(null);
  const [calendar, setCalendar] = useState<CalendarStatus | null>(null);
  const [slack, setSlack] = useState<SlackStatus | null>(null);
  const [agents, setAgents] = useState<AgentsStatus | null>(null);
  const [open, setOpen] = useState<Id | null>(null);

  const refresh = useCallback(() => {
    api.remindersStatus().then(setReminders).catch(() => undefined);
    api.calendarStatus().then(setCalendar).catch(() => undefined);
    api.slackStatus().then(setSlack).catch(() => undefined);
    api.agentsStatus().then(setAgents).catch(() => undefined);
  }, []);

  useEffect(() => {
    refresh();
    const subs = [onRemindersChanged(refresh), onCalendarChanged(refresh), onSlackChanged(refresh), onInboxChanged(refresh)];
    return () => subs.forEach((p) => void p.then((u) => u()));
  }, [refresh]);

  const toggle = (id: Id) => setOpen((o) => (o === id ? null : id));

  return (
    <div className="connectors">
      <p className="connectors-intro">
        Connect apps to use your tasks with them. Everything runs from this Mac — there's no Plucky server or
        account.
      </p>

      <ConnectorCard
        icon={<CalendarGlyph />}
        tone="calendar"
        name="Calendar"
        description="See your meetings next to your tasks in the menu bar."
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
        description="Sync tasks both ways, and tick them off on your iPhone."
        connected={!!reminders?.enabled}
        open={open === "reminders"}
        onToggle={() => toggle("reminders")}
      >
        <RemindersSection embedded />
      </ConnectorCard>

      <ConnectorCard
        icon={<ChatGlyph />}
        tone="slack"
        name="Slack"
        description="Find to-dos in your direct messages."
        connected={!!slack?.connected}
        open={open === "slack"}
        onToggle={() => toggle("slack")}
      >
        <SlackSection status={slack} />
      </ConnectorCard>

      <ConnectorCard
        icon={<SparkGlyph />}
        tone="agents"
        name="AI agents"
        description="Let Claude and other AI apps on this Mac add tasks — never read them."
        connected={!!agents?.enabled}
        open={open === "agents"}
        onToggle={() => toggle("agents")}
      >
        <AgentsSection status={agents} onStatus={setAgents} />
      </ConnectorCard>

      <p className="connectors-foot">More connectors are on the way.</p>
    </div>
  );
}

type Id = "reminders" | "calendar" | "slack" | "agents";

function ConnectorCard({
  icon,
  tone,
  name,
  description,
  connected,
  open,
  onToggle,
  children,
}: {
  icon: ReactNode;
  tone: string;
  name: string;
  description: string;
  connected: boolean;
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
              <span className="connector-dot" aria-hidden /> Connected
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
          label="Show calendar events in Plucky"
          hint="Meetings appear next to your tasks in the menu bar. Read-only — Plucky never changes your calendar."
          checked={enabled}
          disabled={busy || blocked}
          onChange={(v) => void (v ? turnOn() : turnOff())}
        />
        {busy && <p className="setting-line muted">Waiting for permission…</p>}
        {blocked && (
          <div className="setting-line">
            <span className="dot warn" aria-hidden />
            <span className="setting-line-text">Calendar access is off for Plucky.</span>
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

/** Settings for the Slack connector: sign in, status, disconnect. */
function SlackSection({ status }: { status: SlackStatus | null }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!status) return null;
  if (!status.supported) return <p className="setting-line muted">Slack is available on macOS.</p>;

  async function run(action: () => Promise<void>) {
    setError(null);
    setBusy(true);
    try {
      await action();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  const shownError = error ?? status.error;

  return (
    <div className="connector-body-inner">
      {status.connected || status.needs_reconnect ? (
        <div className="card-stack">
          <div className="setting-line">
            <span className={status.needs_reconnect ? "dot warn" : "dot ok"} aria-hidden />
            <span className="setting-line-text">
              {status.needs_reconnect ? (
                <>Slack sign-in expired for <b>{status.team}</b>. Reconnect to keep going.</>
              ) : (
                <>
                  Connected to <b>{status.team}</b>
                </>
              )}
            </span>
          </div>
          <p className="setting-line muted">
            Turning your DMs into suggested tasks arrives in the next update. Plucky keeps the sign-in fresh until then.
          </p>
          <div className="setting-line">
            <span className="setting-line-text muted">Sign-in is stored in your Mac's Keychain.</span>
            {status.needs_reconnect && (
              <button type="button" className="primary small" disabled={busy} onClick={() => void run(api.slackConnect)}>
                Reconnect
              </button>
            )}
            <button type="button" className="ghost small" disabled={busy} onClick={() => void run(api.slackDisconnect)}>
              Disconnect
            </button>
          </div>
        </div>
      ) : (
        <div className="card-stack">
          <p className="setting-line muted">
            Plucky asks Slack to read your direct and group messages and see member names — nothing in channels, and it
            can't post. It talks to Slack directly from this Mac; there's no Plucky server.
          </p>
          {status.connecting ? (
            <div className="setting-line">
              <span className="onboard-pulse" aria-hidden />
              <span className="setting-line-text">Finish signing in in your browser…</span>
              <button type="button" className="ghost small" onClick={() => void run(api.slackCancel)}>
                Cancel
              </button>
            </div>
          ) : (
            <div className="setting-line">
              <span className="setting-line-text muted">Opens Slack's sign-in page in your browser.</span>
              <button type="button" className="primary small" disabled={busy} onClick={() => void run(api.slackConnect)}>
                Sign in with Slack
              </button>
            </div>
          )}
        </div>
      )}
      {shownError && <p className="rem-error">{shownError}</p>}
    </div>
  );
}

/** Settings for AI agents: on/off and how to connect each app. */
function AgentsSection({ status, onStatus }: { status: AgentsStatus | null; onStatus: (s: AgentsStatus) => void }) {
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  if (!status) return null;
  if (!status.supported) return <p className="setting-line muted">AI agents are available on macOS.</p>;

  const quoted = `"${status.command}"`;
  const claudeCode = `claude mcp add --scope user plucky -- ${quoted} --mcp`;
  const generic = JSON.stringify({ mcpServers: { plucky: { command: status.command, args: ["--mcp"] } } }, null, 2);

  async function copy(key: string, text: string) {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(key);
      window.setTimeout(() => setCopied((c) => (c === key ? null : c)), 1600);
    } catch (e) {
      setError(String(e));
    }
  }

  async function run(action: () => Promise<AgentsStatus>) {
    setError(null);
    try {
      onStatus(await action());
    } catch (e) {
      setError(String(e));
    }
  }

  return (
    <div className="connector-body-inner">
      <div className="card-stack">
        <Toggle
          label="Let AI agents on this Mac add tasks"
          hint="Their tasks wait in the menu bar until you add them. Agents can never read, change or delete your tasks."
          checked={status.enabled}
          onChange={(v) => void run(() => api.agentsSetEnabled(v))}
        />
        <div className="setting-line">
          <span className="dot ok" aria-hidden />
          <span className="setting-line-text muted">
            Runs only on this Mac over MCP — nothing goes through the internet, and apps in the cloud can't reach it.
          </span>
        </div>
      </div>

      {status.temporary_location && (
        <div className="setting-line">
          <span className="dot warn" aria-hidden />
          <span className="setting-line-text">
            Move Plucky to your Applications folder first — apps connect to it where it is now.
          </span>
        </div>
      )}

      {status.enabled && (
        <>
          <h4 className="connector-subhead">Connect an app</h4>
          <div className="agent-apps">
            <div className="agent-app">
              <div className="agent-app-head">
                <b>Claude Desktop</b>
                {status.claude_desktop_connected ? (
                  <span className="agent-ok">✓ Added</span>
                ) : (
                  <button
                    type="button"
                    className="primary small"
                    disabled={!status.claude_desktop}
                    onClick={() => void run(api.agentsConnectClaudeDesktop)}
                  >
                    Add to Claude Desktop
                  </button>
                )}
              </div>
              <p className="agent-app-hint">
                {status.claude_desktop_connected
                  ? "Quit and reopen Claude Desktop to pick up Plucky."
                  : status.claude_desktop
                    ? "Adds Plucky to Claude Desktop's MCP servers and keeps a backup of its settings."
                    : "Claude Desktop isn't installed on this Mac."}
              </p>
            </div>

            <div className="agent-app">
              <div className="agent-app-head">
                <b>Claude Code</b>
                <button type="button" className="ghost small" onClick={() => void copy("code", claudeCode)}>
                  {copied === "code" ? "Copied" : "Copy command"}
                </button>
              </div>
              <code className="agent-cmd">{claudeCode}</code>
            </div>

            <div className="agent-app">
              <div className="agent-app-head">
                <b>Other MCP apps</b>
                <button type="button" className="ghost small" onClick={() => void copy("json", generic)}>
                  {copied === "json" ? "Copied" : "Copy JSON"}
                </button>
              </div>
              <p className="agent-app-hint">Cursor, VS Code, LM Studio and others: add a stdio server that runs</p>
              <code className="agent-cmd">{quoted} --mcp</code>
            </div>
          </div>
          <p className="setting-line muted">
            Then try: “Add a Plucky task to call the dentist Tuesday at 10am.”
          </p>
        </>
      )}
      {error && <p className="rem-error">{error}</p>}
    </div>
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

function ChatGlyph() {
  return (
    <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6">
      <path d="M4 4.5h12a1.5 1.5 0 0 1 1.5 1.5v7a1.5 1.5 0 0 1-1.5 1.5H9l-3.5 3v-3H4A1.5 1.5 0 0 1 2.5 13V6A1.5 1.5 0 0 1 4 4.5Z" strokeLinejoin="round" />
      <path d="M6 8.5h8M6 11h5" strokeLinecap="round" />
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
