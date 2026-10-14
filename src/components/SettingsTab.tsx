import { useEffect, useRef, useState } from "react";
import { api } from "../lib/api";
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
}

const ROWS: { action: ShortcutAction; title: string; hint: string; optional: boolean }[] = [
  {
    action: "capture",
    title: "Capture selected text",
    hint: "Select text in any app, then press this to turn it into a task.",
    optional: false,
  },
  {
    action: "toggle_panel",
    title: "Show or hide Pluck",
    hint: "Open your task list from anywhere. Optional.",
    optional: true,
  },
];

export function SettingsTab({ shortcuts, onShortcuts }: Props) {
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
    <div className="settings">
      <section className="settings-section">
        <h2 className="settings-h">Keyboard shortcuts</h2>
        <p className="settings-intro">
          These work in every app while Pluck is running. Click a shortcut, then press the keys you want.
        </p>
        {ROWS.map((row) => {
          const current = shortcuts ? (row.action === "capture" ? shortcuts.capture : shortcuts.toggle_panel) : null;
          const warning = current ? shortcutWarning(current) : null;
          return (
            <div key={row.action} className="shortcut-row">
              <div className="shortcut-text">
                <h3>{row.title}</h3>
                <p>{row.hint}</p>
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
                    const other =
                      row.action === "capture" ? (shortcuts?.toggle_panel ?? null) : (shortcuts?.capture ?? null);
                    const err =
                      validateShortcut(spec) ??
                      (sameShortcut(spec, other) ? "That shortcut is already used for the other action." : null);
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
        <button type="button" className="ghost reset-btn" disabled={busy} onClick={() => void reset()}>
          Restore default ({formatShortcut({ meta: isMac(), ctrl: !isMac(), alt: false, shift: true, code: "KeyZ" })})
        </button>
      </section>

      <section className="settings-section">
        <h2 className="settings-h">Panel</h2>
        <p className="settings-intro">Drag the panel by its header to put it anywhere. Pluck remembers the spot.</p>
        <button type="button" className="ghost" onClick={() => void api.snapPanelToEdge()}>
          Snap to right edge
        </button>
      </section>
    </div>
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

  // While recording, Pluck's own global shortcuts are paused so pressing the
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
