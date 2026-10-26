import { useCallback, useEffect, useState } from "react";
import { api, onSyncChanged, onTasksChanged } from "../lib/api";
import { timeAgo } from "../lib/format";
import type { ProjectSummary, SyncPairing, SyncStatus } from "../lib/types";
import { Toggle } from "./GeneralSettings";

/**
 * Sync with your other Macs: pair with a code and six matching digits, see
 * the Macs in the group, keep projects on this Mac only, or turn it off.
 */
export function SyncSection({ status, onStatus }: { status: SyncStatus | null; onStatus: (s: SyncStatus) => void }) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [joining, setJoining] = useState(false);
  const [code, setCode] = useState("");
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [, tick] = useState(0);

  const refresh = useCallback(() => {
    api.syncStatus().then(onStatus).catch(() => undefined);
  }, [onStatus]);

  useEffect(() => {
    const load = () => api.listProjects().then(setProjects).catch(() => undefined);
    load();
    const sub = onTasksChanged(load);
    return () => void sub.then((u) => u());
  }, []);

  // Keep "2 min ago" fresh, and follow a pairing closely.
  const pairing = status?.pairing ?? null;
  const live = !!pairing && pairing.stage !== "done" && pairing.stage !== "failed";
  useEffect(() => {
    const t = setInterval(() => (live ? refresh() : tick((n) => n + 1)), live ? 1500 : 20_000);
    return () => clearInterval(t);
  }, [live, refresh]);

  async function run(f: () => Promise<unknown>) {
    setError(null);
    setBusy(true);
    try {
      await f();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
      refresh();
    }
  }

  if (!status) return null;

  if (pairing) {
    return (
      <div className="connector-body-inner">
        <PairingPanel pairing={pairing} busy={busy} run={run} />
        {error && <p className="rem-error">{error}</p>}
      </div>
    );
  }

  const join = () => void run(async () => {
    await api.syncJoin(code);
    setJoining(false);
    setCode("");
  });

  if (!status.on) {
    return (
      <div className="connector-body-inner">
        {status.removed_notice && (
          <div className="sync-note">
            <span>Another Mac removed this one from sync. Your tasks are still here.</span>
            <button type="button" className="ghost small" onClick={() => void run(api.syncDismissNotice)}>
              OK
            </button>
          </div>
        )}
        <p className="sync-lead">
          Keep the same tasks on your work and personal Macs — no iCloud or account needed. Changes are locked on this Mac
          before they leave, with a key only your Macs have. The relay in between passes sealed boxes along and can't open
          them.
        </p>
        {joining ? (
          <form
            className="sync-join"
            onSubmit={(e) => {
              e.preventDefault();
              join();
            }}
          >
            <label htmlFor="sync-code">Code from your other Mac</label>
            <div className="sync-join-row">
              <input
                id="sync-code"
                value={code}
                onChange={(e) => setCode(e.target.value.toUpperCase())}
                placeholder="K7MX-4QRB"
                autoFocus
                spellCheck={false}
                autoComplete="off"
                maxLength={12}
              />
              <button type="submit" className="primary small" disabled={busy || code.replace(/[^A-Za-z0-9]/g, "").length !== 8}>
                Join
              </button>
              <button type="button" className="ghost small" onClick={() => setJoining(false)}>
                Cancel
              </button>
            </div>
          </form>
        ) : (
          <div className="sync-start">
            <button type="button" className="primary" disabled={busy} onClick={() => void run(api.syncAddMac)}>
              Show a code on this Mac
            </button>
            <button type="button" className="ghost" disabled={busy} onClick={() => setJoining(true)}>
              I have a code
            </button>
          </div>
        )}
        <ol className="sync-steps">
          <li>On one Mac, choose <strong>Show a code</strong>.</li>
          <li>On the other, choose <strong>I have a code</strong> and type it in.</li>
          <li>Check both Macs show the same six digits, and confirm on both.</li>
        </ol>
        {error && <p className="rem-error">{error}</p>}
      </div>
    );
  }

  const others = status.devices.filter((d) => !d.me);
  const synced = timeAgo(status.last_ok);
  const line = status.busy
    ? "Syncing…"
    : status.error
      ? status.error
      : status.pending > 0
        ? `${status.pending} change${status.pending === 1 ? "" : "s"} waiting to send`
        : synced
          ? `Up to date · synced ${synced}`
          : "Starting…";

  return (
    <div className="connector-body-inner">
      <div className="card-stack">
        <div className="setting-line">
          <span className={status.error ? "dot warn" : "dot ok"} aria-hidden />
          <span className="setting-line-text">{line}</span>
          <button type="button" className="ghost small" disabled={status.busy} onClick={() => void run(api.syncNow)}>
            Sync now
          </button>
        </div>
      </div>

      <h4 className="connector-subhead">Your Macs</h4>
      <ul className="sync-devices">
        {status.devices.map((d) =>
          d.me ? (
            <MeRow key={d.id} name={d.name} onRename={(n) => void run(() => api.syncRename(n))} />
          ) : (
            <OtherRow key={d.id} name={d.name} lastSeen={d.last_seen} onRemove={() => void run(() => api.syncRemove(d.id))} />
          ),
        )}
      </ul>
      {others.length === 0 && <p className="sync-hint">No other Mac yet. Add one to start syncing.</p>}
      <div className="rem-actions">
        <button type="button" className="ghost small" disabled={busy} onClick={() => void run(api.syncAddMac)}>
          + Add a Mac
        </button>
      </div>

      {projects.length > 0 && (
        <>
          <h4 className="connector-subhead">Keep on this Mac only</h4>
          <div className="card-stack">
            {projects.map((p) => (
              <Toggle
                key={p.name}
                label={p.name}
                hint={status.local_only.includes(p.name) ? "Stays here; not on your other Macs." : undefined}
                checked={status.local_only.includes(p.name)}
                onChange={(on) => void run(() => api.syncLocalOnly(p.name, on))}
              />
            ))}
          </div>
          <p className="sync-hint">Turning one on takes its tasks off your other Macs; they stay here.</p>
        </>
      )}

      <LeaveRow busy={busy} onLeave={() => void run(api.syncLeave)} />
      <p className="sync-hint">
        Lost a Mac? Turn sync off on your other Macs and pair them again — that makes a new key the lost Mac doesn't have.
      </p>
      {error && <p className="rem-error">{error}</p>}
    </div>
  );
}

function PairingPanel({
  pairing,
  busy,
  run,
}: {
  pairing: SyncPairing;
  busy: boolean;
  run: (f: () => Promise<unknown>) => Promise<void>;
}) {
  const host = pairing.role === "host";
  if (pairing.stage === "failed" || pairing.stage === "done") {
    const ok = pairing.stage === "done";
    return (
      <div className={ok ? "sync-pair done" : "sync-pair failed"}>
        <p className="sync-pair-title">{ok ? (host ? "Mac added" : "This Mac joined") : "Pairing stopped"}</p>
        <p className="sync-pair-text">
          {ok
            ? host
              ? "Your other Mac is getting your tasks now. Changes on either Mac show up on both."
              : "Your tasks from the other Mac are on their way. Changes on either Mac show up on both."
            : pairing.error}
        </p>
        <button type="button" className="primary small" onClick={() => void run(api.syncPairDismiss)}>
          {ok ? "Done" : "OK"}
        </button>
      </div>
    );
  }
  if (pairing.stage === "waiting") {
    return (
      <div className="sync-pair">
        {host ? (
          <>
            <p className="sync-pair-title">On your other Mac, enter this code</p>
            <p className="sync-code" aria-label={`Code ${pairing.code.split("").join(" ")}`}>
              {pairing.code}
            </p>
            <p className="sync-pair-text">
              Todo City → Settings → Your other Macs → <strong>I have a code</strong>. It works for 10 minutes.
            </p>
          </>
        ) : (
          <>
            <p className="sync-pair-title">Connecting to your other Mac…</p>
            <p className="sync-pair-text">Code {pairing.code}</p>
          </>
        )}
        <button type="button" className="ghost small" onClick={() => void run(api.syncPairCancel)}>
          Cancel
        </button>
      </div>
    );
  }
  return (
    <div className="sync-pair">
      <p className="sync-pair-title">Do both Macs show this number?</p>
      <p className="sync-sas">{pairing.sas}</p>
      {pairing.confirmed ? (
        <p className="sync-pair-text">
          {host ? "Waiting for the other Mac to confirm…" : "Waiting for the other Mac…"}
        </p>
      ) : (
        <>
          <p className="sync-pair-text">
            If they match, nobody is in between. If not, stop — something swapped the keys.
          </p>
          <div className="sync-pair-actions">
            <button type="button" className="primary small" disabled={busy} onClick={() => void run(() => api.syncPairConfirm(true))}>
              They match
            </button>
            <button type="button" className="ghost small" disabled={busy} onClick={() => void run(() => api.syncPairConfirm(false))}>
              They don't
            </button>
          </div>
        </>
      )}
    </div>
  );
}

function MeRow({ name, onRename }: { name: string; onRename: (n: string) => void }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(name);
  if (editing) {
    return (
      <li className="sync-device me">
        <form
          className="sync-rename"
          onSubmit={(e) => {
            e.preventDefault();
            onRename(draft);
            setEditing(false);
          }}
        >
          <input value={draft} onChange={(e) => setDraft(e.target.value)} autoFocus maxLength={60} aria-label="This Mac's name" />
          <button type="submit" className="primary small">
            Save
          </button>
        </form>
      </li>
    );
  }
  return (
    <li className="sync-device me">
      <MacGlyph />
      <span className="sync-device-name">
        {name} <span className="sync-device-tag">This Mac</span>
      </span>
      <button
        type="button"
        className="de-link"
        onClick={() => {
          setDraft(name);
          setEditing(true);
        }}
      >
        Rename
      </button>
    </li>
  );
}

function OtherRow({ name, lastSeen, onRemove }: { name: string; lastSeen: string | null; onRemove: () => void }) {
  const [sure, setSure] = useState(false);
  const seen = timeAgo(lastSeen);
  return (
    <li className="sync-device">
      <MacGlyph />
      <span className="sync-device-name">
        {name}
        <span className="sync-device-seen">{seen ? `Seen ${seen}` : "Not seen yet"}</span>
      </span>
      {sure ? (
        <>
          <button type="button" className="de-link danger" onClick={onRemove}>
            Remove
          </button>
          <button type="button" className="de-link" onClick={() => setSure(false)}>
            Keep
          </button>
        </>
      ) : (
        <button type="button" className="de-link" onClick={() => setSure(true)} title="Stop syncing with this Mac">
          Remove…
        </button>
      )}
    </li>
  );
}

function LeaveRow({ busy, onLeave }: { busy: boolean; onLeave: () => void }) {
  const [sure, setSure] = useState(false);
  return (
    <div className="sync-leave">
      {sure ? (
        <>
          <span>Stop syncing this Mac? Its tasks stay here, and your other Macs keep theirs.</span>
          <button type="button" className="ghost small danger" disabled={busy} onClick={onLeave}>
            Turn off
          </button>
          <button type="button" className="ghost small" onClick={() => setSure(false)}>
            Cancel
          </button>
        </>
      ) : (
        <button type="button" className="de-link" onClick={() => setSure(true)}>
          Turn off sync on this Mac…
        </button>
      )}
    </div>
  );
}

function MacGlyph() {
  return (
    <svg className="sync-mac" width="16" height="16" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden>
      <rect x="2.5" y="3.5" width="15" height="10" rx="1.6" />
      <path d="M7 16.5h6M10 13.5v3" strokeLinecap="round" />
    </svg>
  );
}

export function SyncGlyph() {
  return (
    <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <path d="M15.5 7.5A6 6 0 0 0 4.8 6.2M4.5 12.5a6 6 0 0 0 10.7 1.3" />
      <path d="M4.5 3.5v3h3M15.5 16.5v-3h-3" />
    </svg>
  );
}

/** Keep sync status in a parent (the Connectors card shows On / Off). */
export function useSyncStatus(): [SyncStatus | null, (s: SyncStatus) => void] {
  const [status, setStatus] = useState<SyncStatus | null>(null);
  useEffect(() => {
    const load = () => api.syncStatus().then(setStatus).catch(() => undefined);
    load();
    const sub = onSyncChanged(load);
    return () => void sub.then((u) => u());
  }, []);
  return [status, setStatus];
}
