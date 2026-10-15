import { useCallback, useEffect, useState } from "react";
import { api, onRemindersChanged } from "../lib/api";
import { safeLocale } from "../lib/locale";
import type { RemindersList, RemindersStatus } from "../lib/types";
import { Toggle } from "./GeneralSettings";

const LOCALE = safeLocale();
const NEW_LIST = "__new__";

/**
 * Settings → Apple Reminders. Off by default. Turning it on always shows the
 * iCloud warning and needs an explicit acknowledgement when the chosen list
 * can sync off this Mac.
 */
export function RemindersSection() {
  const [status, setStatus] = useState<RemindersStatus | null>(null);
  const [setup, setSetup] = useState(false);
  const [lists, setLists] = useState<RemindersList[]>([]);
  const [choice, setChoice] = useState<string>(NEW_LIST);
  const [pushExisting, setPushExisting] = useState(true);
  const [includeNotes, setIncludeNotes] = useState(false);
  const [acknowledged, setAcknowledged] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setStatus(await api.remindersStatus());
    } catch (e) {
      setError(String(e));
    }
  }, []);

  useEffect(() => {
    void refresh();
    const sub = onRemindersChanged(() => void refresh());
    return () => void sub.then((u) => u());
  }, [refresh]);

  if (!status || !status.supported) return null;

  async function startSetup() {
    setError(null);
    setBusy(true);
    try {
      let access = status!.access;
      if (access === "not_determined") access = await api.remindersRequestAccess();
      await refresh();
      if (access !== "full") return;
      const found = (await api.remindersLists()).filter((l) => l.writable);
      setLists(found);
      const existing = found.find((l) => l.title === "Pluck");
      setChoice(existing ? existing.id : NEW_LIST);
      setAcknowledged(false);
      setSetup(true);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  async function turnOn() {
    setError(null);
    setBusy(true);
    try {
      await api.remindersEnable({
        list_id: choice === NEW_LIST ? null : choice,
        include_notes: includeNotes,
        push_existing: pushExisting,
      });
      setSetup(false);
      await refresh();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  async function turnOff() {
    setBusy(true);
    try {
      await api.remindersDisable();
      await refresh();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  const chosen = lists.find((l) => l.id === choice) ?? null;
  // A new list goes to the default Reminders account, which is usually iCloud.
  const mayLeave = choice === NEW_LIST ? true : (chosen?.leaves_mac ?? true);
  const needsAck = mayLeave;
  const accessBlocked = status.access === "denied" || status.access === "restricted";

  const synced = status.last_sync
    ? ` · synced ${new Date(status.last_sync).toLocaleTimeString(LOCALE, { hour: "numeric", minute: "2-digit" })}`
    : "";

  return (
    <section className="settings-section">
      <h2 className="settings-h">Apple Reminders</h2>

      {!status.enabled && !setup && (
        <div className="card-stack">
          <Toggle
            label="Sync with Apple Reminders"
            hint="Two-way: tick a task off on your iPhone and it’s done here too."
            checked={false}
            disabled={busy || accessBlocked}
            onChange={(v) => v && void startSetup()}
          />
          {busy && <p className="setting-line muted">Waiting for permission…</p>}
          {accessBlocked && (
            <div className="setting-line">
              <span className="dot warn" aria-hidden />
              <span className="setting-line-text">Reminders access is off for Pluck.</span>
              <button type="button" className="ghost small" onClick={() => void api.remindersOpenPrivacySettings()}>
                Allow
              </button>
            </div>
          )}
        </div>
      )}

      {!status.enabled && setup && (
        <>
          <div className="card-stack">
            <label className="setting-select">
              <span className="toggle-text">
                <span className="toggle-label">List</span>
                <span className="toggle-hint">Where your tasks appear in Reminders.</span>
              </span>
              <select value={choice} onChange={(e) => setChoice(e.target.value)}>
                <option value={NEW_LIST}>New list “Pluck”</option>
                {lists.map((l) => (
                  <option key={l.id} value={l.id}>
                    {l.title} — {l.source}
                  </option>
                ))}
              </select>
            </label>
            <Where leaves={mayLeave} source={chosen && !chosen.icloud ? chosen.source : "iCloud"} />
            <Toggle
              label="Add my open tasks too"
              hint="Copies the tasks already in Pluck to the list."
              checked={pushExisting}
              onChange={setPushExisting}
            />
            <Toggle
              label="Include the original text"
              hint="Puts the text you selected in each reminder’s notes."
              checked={includeNotes}
              onChange={setIncludeNotes}
            />
            {needsAck && (
              <Toggle
                label={`OK to copy tasks to ${chosen && !chosen.icloud ? chosen.source : "iCloud"}`}
                hint="Titles and dates sync to your other devices. Pick an “On My Mac” list to keep everything here."
                checked={acknowledged}
                onChange={setAcknowledged}
              />
            )}
          </div>
          <div className="rem-actions">
            <button type="button" className="ghost" disabled={busy} onClick={() => setSetup(false)}>
              Cancel
            </button>
            <button
              type="button"
              className="primary"
              disabled={busy || (needsAck && !acknowledged)}
              onClick={() => void turnOn()}
            >
              {busy ? "Turning on…" : "Turn on sync"}
            </button>
          </div>
        </>
      )}

      {status.enabled && (
        <div className="card-stack">
          <Toggle
            label="Sync with Apple Reminders"
            hint={`${status.list ? `“${status.list.title}” · ` : ""}${status.linked} ${status.linked === 1 ? "task" : "tasks"} linked${synced}`}
            checked
            disabled={busy}
            onChange={(v) => !v && void turnOff()}
          />
          <Where
            leaves={!(status.list && !status.list.leaves_mac)}
            source={status.list?.icloud === false ? status.list.source : "iCloud"}
          />
          <Toggle
            label="Include the original text"
            hint="Puts the text you selected in new reminders’ notes."
            checked={status.include_notes}
            onChange={(v) => void api.remindersSetIncludeNotes(v).then(refresh)}
          />
          <div className="setting-line">
            <span className="setting-line-text muted">
              Deleting a task here deletes its reminder. Deleting a reminder keeps the task.
            </span>
            <button type="button" className="ghost small" disabled={busy} onClick={() => void api.remindersSyncNow()}>
              Sync now
            </button>
          </div>
          {status.access !== "full" && (
            <div className="setting-line">
              <span className="dot warn" aria-hidden />
              <span className="setting-line-text">Reminders access is off for Pluck.</span>
              <button type="button" className="ghost small" onClick={() => void api.remindersOpenPrivacySettings()}>
                Allow
              </button>
            </div>
          )}
        </div>
      )}

      {status.last_error && status.enabled && <p className="rem-error">{status.last_error}</p>}
      {error && <p className="rem-error">{error}</p>}
    </section>
  );
}

/** One line saying whether the list keeps tasks on this Mac. */
function Where({ leaves, source }: { leaves: boolean; source: string }) {
  return (
    <div className="setting-line">
      <span className={leaves ? "dot warn" : "dot ok"} aria-hidden />
      <span className="setting-line-text">
        {leaves ? `Syncs through ${source} — tasks leave this Mac.` : "Stored only on this Mac."}
      </span>
    </div>
  );
}
