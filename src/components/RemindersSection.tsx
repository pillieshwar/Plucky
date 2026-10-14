import { useCallback, useEffect, useState } from "react";
import { api, onRemindersChanged } from "../lib/api";
import { safeLocale } from "../lib/locale";
import type { RemindersList, RemindersStatus } from "../lib/types";

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
      const existingPluck = found.find((l) => l.title === "Pluck");
      setChoice(existingPluck ? existingPluck.id : NEW_LIST);
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

  return (
    <section className="settings-section">
      <h2 className="settings-h">Apple Reminders</h2>

      {!status.enabled && !setup && (
        <>
          <p className="settings-intro">
            Add new tasks to the Reminders app and keep them in sync both ways — check one off on your iPhone and it’s
            done in Pluck too.
          </p>
          {accessBlocked ? (
            <div className="rem-note error">
              <p>
                Reminders access is turned off for Pluck. Turn it on in System Settings → Privacy &amp; Security →
                Reminders, then come back here.
              </p>
              <button type="button" className="ghost" onClick={() => void api.remindersOpenPrivacySettings()}>
                Open System Settings
              </button>
            </div>
          ) : (
            <button type="button" className="ghost" disabled={busy} onClick={() => void startSetup()}>
              {busy ? "Waiting for permission…" : "Set up Reminders sync…"}
            </button>
          )}
        </>
      )}

      {!status.enabled && setup && (
        <div className="rem-setup">
          <PrivacyWarning detail />

          <label className="rem-field">
            <span>Sync with</span>
            <select value={choice} onChange={(e) => setChoice(e.target.value)}>
              <option value={NEW_LIST}>New list “Pluck”</option>
              {lists.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.title} — {l.source}
                </option>
              ))}
            </select>
          </label>
          <p className={mayLeave ? "rem-dest leaves" : "rem-dest local"}>
            {choice === NEW_LIST
              ? "Created in your default Reminders account — usually iCloud."
              : chosen?.leaves_mac
                ? `This list syncs through ${chosen.source}.`
                : "This list is stored only on this Mac."}
          </p>

          <label className="rem-check">
            <input type="checkbox" checked={pushExisting} onChange={(e) => setPushExisting(e.target.checked)} />
            Also add the open tasks already in Pluck
          </label>
          <label className="rem-check">
            <input type="checkbox" checked={includeNotes} onChange={(e) => setIncludeNotes(e.target.checked)} />
            Include the original selected text in each reminder’s notes
          </label>
          {needsAck && (
            <label className="rem-check ack">
              <input type="checkbox" checked={acknowledged} onChange={(e) => setAcknowledged(e.target.checked)} />I
              understand my tasks will be copied to {chosen && !chosen.icloud ? chosen.source : "iCloud"} and leave this
              Mac.
            </label>
          )}

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
        </div>
      )}

      {status.enabled && (
        <div className="rem-on">
          <p className="rem-line">
            <span className="rem-pill">On</span>
            {status.list ? (
              <>
                Syncing with <b>“{status.list.title}”</b> · {status.list.source}
              </>
            ) : (
              "Syncing with Reminders"
            )}
          </p>
          {status.list && !status.list.leaves_mac ? (
            <p className="rem-dest local">This list is stored only on this Mac.</p>
          ) : (
            <PrivacyWarning source={status.list?.icloud === false ? status.list.source : "iCloud"} />
          )}
          <label className="rem-check">
            <input
              type="checkbox"
              checked={status.include_notes}
              onChange={(e) => {
                void api.remindersSetIncludeNotes(e.target.checked).then(refresh);
              }}
            />
            Include the original selected text in new reminders’ notes
          </label>
          <p className="rem-meta">
            {status.linked} {status.linked === 1 ? "task" : "tasks"} linked
            {status.last_sync && (
              <>
                {" "}
                · last synced{" "}
                {new Date(status.last_sync).toLocaleTimeString(LOCALE, { hour: "numeric", minute: "2-digit" })}
              </>
            )}
          </p>
          {status.last_error && <p className="rem-error">{status.last_error}</p>}
          {status.access !== "full" && (
            <button type="button" className="ghost" onClick={() => void api.remindersOpenPrivacySettings()}>
              Open System Settings
            </button>
          )}
          <p className="rem-small">
            Deleting a task in Pluck deletes its reminder. Deleting a reminder only unlinks it — the task stays in
            Pluck.
          </p>
          <div className="rem-actions">
            <button type="button" className="ghost" disabled={busy} onClick={() => void api.remindersSyncNow()}>
              Sync now
            </button>
            <button type="button" className="ghost" disabled={busy} onClick={() => void turnOff()}>
              Turn off
            </button>
          </div>
        </div>
      )}

      {error && <p className="rem-error">{error}</p>}
    </section>
  );
}

function PrivacyWarning({ detail, source = "iCloud" }: { detail?: boolean; source?: string }) {
  return (
    <div className="rem-warning" role="note">
      <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden fill="none" stroke="currentColor" strokeWidth="1.6">
        <path d="M8 1.8 15 14H1L8 1.8Z" strokeLinejoin="round" />
        <path d="M8 6.2v3.6M8 11.6v.4" strokeLinecap="round" />
      </svg>
      <div>
        <p className="rem-warning-title">Your tasks may leave this Mac</p>
        {detail ? (
          <p>
            If the Reminders list syncs with iCloud (or another account), everything Pluck adds to it — task titles, due
            dates and, if you choose, the original selected text — is uploaded to that account and appears on your other
            devices. Pluck’s own processing still happens only on this Mac. To keep everything local, pick a list stored
            “On My Mac”.
          </p>
        ) : (
          <p>
            Tasks are copied to {source} and your other devices through this Reminders list. Pluck’s own processing
            still happens only on this Mac.
          </p>
        )}
      </div>
    </div>
  );
}
