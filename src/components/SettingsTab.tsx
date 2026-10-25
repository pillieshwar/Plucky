import { useEffect, useRef, useState } from "react";
import { api } from "../lib/api";
import { AppearanceSection, CustomizeSection, DataSection, GeneralSection, MenuBarNudgesSection, NotificationsSection } from "./GeneralSettings";
import type { AppSettings, Status, UpdateStatus } from "../lib/types";
import {
  formatShortcut,
  sameShortcut,
  shortcutWarning,
  specFromKeyEvent,
  validateShortcut,
  type ShortcutAction,
  type ShortcutSettings,
  type ShortcutSpec,
} from "../lib/shortcuts";

interface Props {
  shortcuts: ShortcutSettings | null;
  onShortcuts: (s: ShortcutSettings) => void;
  settings: AppSettings | null;
  onSettings: (s: AppSettings) => void;
  status: Status | null;
  update: UpdateStatus;
  onError: (message: string) => void;
  /** Start the first-run tour again. */
  onTour: () => void;
}

const ROWS: { action: ShortcutAction; title: string; hint: string; optional: boolean }[] = [
  {
    action: "capture",
    title: "Capture selected text",
    hint: "Select text in any app, then press this to turn it into a task.",
    optional: false,
  },
  {
    action: "quick_add",
    title: "Quick add",
    hint: "Type a task from anywhere — “pay rent friday 5pm #home”.",
    optional: true,
  },
  {
    action: "toggle_panel",
    title: "Show or hide Plucky",
    hint: "Open your task list from anywhere — even over a full-screen app, where the menu bar is hidden.",
    optional: true,
  },
];

export function SettingsTab({ shortcuts, onShortcuts, settings, onSettings, status, update, onError, onTour }: Props) {
  return (
    <div className="settings">
      <AppearanceSection settings={settings} onSettings={onSettings} onError={onError} />

      <CustomizeSection settings={settings} onSettings={onSettings} onError={onError} />

      <MenuBarNudgesSection settings={settings} onSettings={onSettings} onError={onError} />

      <NotificationsSection settings={settings} onSettings={onSettings} onError={onError} />

      <section className="settings-section">
        <h2 className="settings-h">Keyboard shortcuts</h2>
        <p className="settings-intro">
          These work in every app while Plucky is running. Click a shortcut, then press the keys you want.
        </p>
        <ShortcutEditor shortcuts={shortcuts} onShortcuts={onShortcuts} />
      </section>

      <GeneralSection
        settings={settings}
        onSettings={onSettings}
        status={status}
        update={update}
        onError={onError}
        onTour={onTour}
      />

      <DataSection onError={onError} />

      <section className="settings-section">
        <h2 className="settings-h">Panel</h2>
        <p className="settings-intro">Drag the panel by its header to put it anywhere. Plucky remembers the spot.</p>
        <button type="button" className="ghost" onClick={() => void api.snapPanelToEdge()}>
          Snap to right edge
        </button>
      </section>

      <section className="settings-section">
        <h2 className="settings-h">Troubleshooting</h2>
        <p className="settings-intro">
          Plucky keeps a log on this Mac (never sent anywhere). If something goes wrong, it helps to attach it to a bug
          report.
        </p>
        <button type="button" className="ghost" onClick={() => void api.revealLogs().catch(() => undefined)}>
          Show log file
        </button>
      </section>
    </div>
  );
}

/** The three global shortcuts, each with a click-to-record keycap. */
export function ShortcutEditor({
  shortcuts,
  onShortcuts,
  compact,
}: {
  shortcuts: ShortcutSettings | null;
  onShortcuts: (s: ShortcutSettings) => void;
  /** Leave out the hints and the reset button (first-run tour). */
  compact?: boolean;
}) {
  const [recording, setRecording] = useState<ShortcutAction | null>(null);
  const [errors, setErrors] = useState<Partial<Record<ShortcutAction, string>>>({});
  const [busy, setBusy] = useState(false);

  async function save(action: ShortcutAction, spec: ShortcutSpec | null) {
    setBusy(true);
    try {
      onShortcuts(await api.setShortcut(action, spec));
      setErrors((e) => ({ ...e, [action]: undefined }));
    } catch (e) {
      setErrors((x) => ({ ...x, [action]: String(e) }));
    } finally {
      setBusy(false);
    }
  }

  async function reset() {
    setBusy(true);
    try {
      onShortcuts(await api.resetShortcuts());
      setErrors({});
    } catch (e) {
      setErrors({ capture: String(e) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
        {ROWS.map((row) => {
          const current = shortcuts ? shortcuts[row.action] : null;
          const warning = current ? shortcutWarning(current) : null;
          return (
            <div key={row.action} className="shortcut-row">
              <div className="shortcut-text">
                <h3>{row.title}</h3>
                {!compact && <p>{row.hint}</p>}
              </div>
              <div className="shortcut-controls">
                <Recorder
                  value={current}
                  recording={recording === row.action}
                  disabled={busy || (recording !== null && recording !== row.action)}
                  onStart={() => {
                    setErrors((e) => ({ ...e, [row.action]: undefined }));
                    setRecording(row.action);
                  }}
                  onCancel={() => setRecording(null)}
                  onRecorded={(spec) => {
                    setRecording(null);
                    const others = ROWS.filter((r) => r.action !== row.action).map((r) =>
                      shortcuts ? shortcuts[r.action] : null,
                    );
                    const err =
                      validateShortcut(spec) ??
                      (others.some((o) => sameShortcut(spec, o))
                        ? "That shortcut is already used by another Plucky action."
                        : null);
                    if (err) setErrors((e) => ({ ...e, [row.action]: err }));
                    else void save(row.action, spec);
                  }}
                />
                {row.optional && current && recording !== row.action && (
                  <button
                    type="button"
                    className="link-btn"
                    disabled={busy}
                    onClick={() => void save(row.action, null)}
                  >
                    Clear
                  </button>
                )}
              </div>
              {errors[row.action] && <p className="shortcut-error">{errors[row.action]}</p>}
              {!errors[row.action] && warning && <p className="shortcut-warn">{warning}</p>}
            </div>
          );
        })}
        {!compact && (
        <button type="button" className="ghost reset-btn" disabled={busy} onClick={() => void reset()}>
          Restore defaults ({["KeyS", "Space", "KeyH"]
            .map((code) => formatShortcut({ meta: isMac(), ctrl: !isMac(), alt: false, shift: true, code }))
            .join(" · ")})
        </button>
        )}
    </>
  );
}

function isMac(): boolean {
  return /Mac/i.test(navigator.platform);
}

function Recorder({
  value,
  recording,
  disabled,
  onStart,
  onCancel,
  onRecorded,
}: {
  value: ShortcutSpec | null;
  recording: boolean;
  disabled: boolean;
  onStart: () => void;
  onCancel: () => void;
  onRecorded: (spec: ShortcutSpec) => void;
}) {
  const [held, setHeld] = useState("");
  const ref = useRef<HTMLButtonElement>(null);
  // Keep the latest callbacks without re-running the recording effect.
  const handlers = useRef({ onCancel, onRecorded });
  handlers.current = { onCancel, onRecorded };

  // While recording, Plucky's own global shortcuts are paused so pressing the
  // current one is recorded instead of triggering a capture.
  useEffect(() => {
    if (!recording) return;
    void api.pauseShortcuts(true);
    ref.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.key === "Escape" && !e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey) {
        handlers.current.onCancel();
        return;
      }
      const spec = specFromKeyEvent(e);
      if (spec) handlers.current.onRecorded(spec);
      else setHeld(modifierPreview(e));
    };
    const onUp = (e: KeyboardEvent) => setHeld(modifierPreview(e));
    const onBlur = () => handlers.current.onCancel();
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("keyup", onUp, true);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("keyup", onUp, true);
      window.removeEventListener("blur", onBlur);
      setHeld("");
      void api.pauseShortcuts(false);
    };
  }, [recording]);

  return (
    <button
      ref={ref}
      type="button"
      className={recording ? "keycap recording" : "keycap"}
      disabled={disabled}
      onClick={() => (recording ? onCancel() : onStart())}
      aria-label={recording ? "Recording — press the new shortcut, or Esc to cancel" : "Change shortcut"}
    >
      {recording ? held || "Press keys…" : value ? formatShortcut(value) : "Not set"}
    </button>
  );
}

function modifierPreview(e: KeyboardEvent): string {
  if (/Mac/i.test(navigator.platform)) {
    return `${e.ctrlKey ? "⌃" : ""}${e.altKey ? "⌥" : ""}${e.shiftKey ? "⇧" : ""}${e.metaKey ? "⌘" : ""}`;
  }
  return [e.ctrlKey && "Ctrl", e.metaKey && "Win", e.altKey && "Alt", e.shiftKey && "Shift"].filter(Boolean).join("+");
}
