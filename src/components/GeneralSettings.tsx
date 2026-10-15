import { useCallback, useEffect, useState } from "react";
import { api } from "../lib/api";
import type { AppSettings, BackupInfo, NotificationPermission, Status, UpdateStatus } from "../lib/types";

interface SettingsProps {
  settings: AppSettings | null;
  onSettings: (s: AppSettings) => void;
  onError: (message: string) => void;
}

function useSave({ settings, onSettings, onError }: SettingsProps) {
  return useCallback(
    async (change: (s: AppSettings) => AppSettings) => {
      if (!settings) return;
      try {
        onSettings(await api.setSettings(change(settings)));
      } catch (e) {
        onError(String(e));
      }
    },
    [settings, onSettings, onError],
  );
}

export function Toggle({
  checked,
  onChange,
  label,
  hint,
  disabled,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
  hint?: string;
  disabled?: boolean;
}) {
  return (
    <label className={disabled ? "toggle-row disabled" : "toggle-row"}>
      <span className="toggle-text">
        <span className="toggle-label">{label}</span>
        {hint && <span className="toggle-hint">{hint}</span>}
      </span>
      <input
        type="checkbox"
        role="switch"
        className="switch"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
      />
    </label>
  );
}

export function updateText(u: UpdateStatus): string {
  switch (u.state) {
    case "checking":
      return "Checking for updates…";
    case "up_to_date":
      return "You have the latest version.";
    case "downloading":
      return `Downloading ${u.version}${u.percent !== null ? ` · ${u.percent}%` : "…"}`;
    case "ready":
      return `Plucky ${u.version} is ready to install.`;
    case "failed":
      return `Couldn't check for updates (${u.message}).`;
    default:
      return "";
  }
}

export function GeneralSection(
  props: SettingsProps & { status: Status | null; update: UpdateStatus; onTour?: () => void },
) {
  const { settings, status, update, onError, onTour } = props;
  const save = useSave(props);
  const [login, setLogin] = useState<boolean | null>(null);

  useEffect(() => {
    api
      .autostartEnabled()
      .then(setLogin)
      .catch(() => setLogin(null));
  }, []);

  async function setLoginItem(on: boolean) {
    try {
      setLogin(await api.setAutostart(on));
    } catch (e) {
      onError(String(e));
    }
  }

  return (
    <section className="settings-section">
      <h2 className="settings-h">General</h2>
      <div className="card-stack">
        <Toggle
          label="Open Plucky when I log in"
          hint="Keeps capture and reminders working after a restart."
          checked={!!login}
          disabled={login === null}
          onChange={(v) => void setLoginItem(v)}
        />
        <Toggle
          label="Show Plucky when my Mac starts or wakes"
          hint="Opens this panel at login and the first time you open your Mac each day."
          checked={settings?.show_on_start ?? true}
          disabled={!settings}
          onChange={(v) => void save((s) => ({ ...s, show_on_start: v }))}
        />
        <Toggle
          label="Remember where tasks came from"
          hint="Saves the app and page link with each capture, on this Mac only."
          checked={settings?.remember_source ?? true}
          disabled={!settings}
          onChange={(v) => void save((s) => ({ ...s, remember_source: v }))}
        />
        <Toggle
          label="Update automatically"
          hint="Downloads signed updates in the background; you choose when to restart."
          checked={settings?.auto_update ?? true}
          disabled={!settings}
          onChange={(v) => void save((s) => ({ ...s, auto_update: v }))}
        />
        <div className="update-line">
          <span>
            Plucky {status?.version ?? ""}
            {update.state !== "idle" && <span className="update-state"> — {updateText(update)}</span>}
          </span>
          {update.state === "ready" ? (
            <button type="button" className="primary small" onClick={() => void api.installUpdate().catch((e) => onError(String(e)))}>
              Restart to update
            </button>
          ) : (
            <button
              type="button"
              className="ghost small"
              disabled={update.state === "checking" || update.state === "downloading"}
              onClick={() => void api.checkForUpdates().catch((e) => onError(String(e)))}
            >
              Check now
            </button>
          )}
        </div>
        {onTour && (
          <div className="update-line">
            <span>New to Plucky, or forgot something?</span>
            <button type="button" className="ghost small" onClick={onTour}>
              Take the tour again
            </button>
          </div>
        )}
      </div>
    </section>
  );
}

export function NotificationsSection(props: SettingsProps) {
  const { settings } = props;
  const save = useSave(props);
  const [permission, setPermission] = useState<NotificationPermission | null>(null);

  useEffect(() => {
    api
      .notificationPermission()
      .then(setPermission)
      .catch(() => setPermission(null));
  }, []);

  async function enable(on: boolean) {
    await save((s) => ({ ...s, notify: { ...s.notify, enabled: on } }));
    if (on && permission === "not_determined") {
      setPermission(await api.requestNotificationPermission().catch(() => null));
    }
  }

  const n = settings?.notify;
  return (
    <section className="settings-section">
      <h2 className="settings-h">Notifications</h2>
      <p className="settings-intro">
        Plucky reminds you when a task is due, right on this Mac. Each reminder has Done, Snooze and Tomorrow buttons.
      </p>
      {permission === "denied" && (
        <div className="rem-note error">
          <p>Notifications for Plucky are turned off in System Settings.</p>
          <button type="button" className="ghost" onClick={() => void api.openNotificationSettings().catch(() => undefined)}>
            Open Notification settings
          </button>
        </div>
      )}
      <div className="card-stack">
        <Toggle
          label="Remind me when tasks are due"
          checked={n?.enabled ?? true}
          disabled={!n}
          onChange={(v) => void enable(v)}
        />
        <label className={n?.enabled ? "toggle-row" : "toggle-row disabled"}>
          <span className="toggle-text">
            <span className="toggle-label">Tasks without a time</span>
            <span className="toggle-hint">Remind me on the day at</span>
          </span>
          <input
            type="time"
            className="time-input"
            value={n?.all_day_time ?? "09:00"}
            disabled={!n?.enabled}
            onChange={(e) =>
              e.target.value && void save((s) => ({ ...s, notify: { ...s.notify, all_day_time: e.target.value } }))
            }
          />
        </label>
        <Toggle
          label="One morning summary instead"
          hint="A single “3 due today, 1 overdue” at that time, rather than one per task. Tasks with a time still remind you on time."
          checked={n?.daily_summary ?? false}
          disabled={!n?.enabled}
          onChange={(v) => void save((s) => ({ ...s, notify: { ...s.notify, daily_summary: v } }))}
        />
      </div>
      <div className="row-actions">
        {permission === "not_determined" ? (
          <button
            type="button"
            className="ghost"
            onClick={() => void api.requestNotificationPermission().then(setPermission).catch(() => undefined)}
          >
            Allow notifications…
          </button>
        ) : (
          <button type="button" className="ghost" onClick={() => void api.testNotification().catch(() => undefined)}>
            Send a test notification
          </button>
        )}
      </div>
    </section>
  );
}

export function DataSection({ onError }: { onError: (message: string) => void }) {
  const [backups, setBackups] = useState<BackupInfo[]>([]);
  const [confirm, setConfirm] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const load = useCallback(() => {
    api
      .listBackups()
      .then(setBackups)
      .catch(() => setBackups([]));
  }, []);
  useEffect(load, [load]);

  async function run(f: () => Promise<unknown>, done?: string) {
    try {
      await f();
      if (done) setNote(done);
      load();
    } catch (e) {
      onError(String(e));
    }
  }

  return (
    <section className="settings-section">
      <h2 className="settings-h">Your data</h2>
      <p className="settings-intro">
        Tasks live in one file on this Mac. Plucky keeps a backup for each of the last 7 days.
      </p>
      <div className="row-actions">
        <button type="button" className="ghost" onClick={() => void run(() => api.exportTasks("csv"), "Saved a CSV to Downloads.")}>
          Export CSV
        </button>
        <button type="button" className="ghost" onClick={() => void run(() => api.exportTasks("json"), "Saved JSON to Downloads.")}>
          Export JSON
        </button>
        <button type="button" className="ghost" onClick={() => void run(api.backupNow, "Backup saved.")}>
          Back up now
        </button>
      </div>
      {note && <p className="settings-note">{note}</p>}
      {backups.length > 0 && (
        <ul className="backup-list">
          {backups.map((b) => (
            <li key={b.name}>
              <span className="backup-name">
                {new Date(`${b.day}T12:00:00`).toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" })}
                {b.name.includes("before-restore") && <span className="backup-tag">before restore</span>}
                {b.name.includes("manual") && <span className="backup-tag">manual</span>}
              </span>
              <span className="backup-size">{Math.max(1, Math.round(b.size / 1024))} KB</span>
              {confirm === b.name ? (
                <span className="backup-confirm">
                  Replace your tasks?
                  <button
                    type="button"
                    className="danger small"
                    onClick={() => {
                      setConfirm(null);
                      void run(() => api.restoreBackup(b.name), "Restored. Your previous tasks were backed up first.");
                    }}
                  >
                    Restore
                  </button>
                  <button type="button" className="link-btn" onClick={() => setConfirm(null)}>
                    Cancel
                  </button>
                </span>
              ) : (
                <button type="button" className="link-btn" onClick={() => setConfirm(b.name)}>
                  Restore…
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      <button type="button" className="link-btn" onClick={() => void api.revealBackups().catch(() => undefined)}>
        Show backups folder
      </button>
    </section>
  );
}
