import { useEffect, useRef, useState } from "react";
import { api, onModelDownload } from "../lib/api";
import { Toggle } from "./GeneralSettings";
import { ShortcutEditor } from "./SettingsTab";
import { formatShortcut, type ShortcutSettings } from "../lib/shortcuts";
import type { AppSettings, ModelInfo, Status } from "../lib/types";

interface Props {
  status: Status | null;
  shortcuts: ShortcutSettings | null;
  onShortcuts: (s: ShortcutSettings) => void;
  settings: AppSettings | null;
  onSettings: (s: AppSettings) => void;
  /** How many tasks exist; a rise during "Try it" means the first capture worked. */
  taskCount: number;
  /** A capture is on screen, so the tour steps aside for it. */
  hidden: boolean;
  onRefreshStatus: () => void;
  /** Run the sample text through a real capture. */
  onTry: (text: string) => void;
  onDone: () => void;
}

const SAMPLE = "Hi! Could you send me the Q3 numbers by Friday 3pm? Thanks!";

const STEPS = ["Welcome", "Permission", "Model", "Shortcuts", "Reminders", "Try it", "Tour"] as const;

/**
 * The first-run tour: what Plucky does, the one permission it needs, the
 * model, shortcuts, reminders, a real capture from the browser, and a quick
 * look around. Shown on first launch and from Settings → General.
 */
export function Onboarding({
  status,
  shortcuts,
  onShortcuts,
  settings,
  onSettings,
  taskCount,
  hidden,
  onRefreshStatus,
  onTry,
  onDone,
}: Props) {
  const [step, setStep] = useState(0);
  const [model, setModel] = useState<ModelInfo | null>(null);
  const [progress, setProgress] = useState<number | null>(null);
  const [modelError, setModelError] = useState<string | null>(null);
  const [notify, setNotify] = useState(settings?.notify.enabled ?? true);
  const [login, setLogin] = useState(true);
  const [showOnStart, setShowOnStart] = useState(settings?.show_on_start ?? true);
  const [captured, setCaptured] = useState(false);
  const baseline = useRef<number | null>(null);

  const hasModel = !!status?.active_model || status?.engine === "ollama";
  const capture = shortcuts ? formatShortcut(shortcuts.capture) : "…";
  const quick = shortcuts?.quick_add ? formatShortcut(shortcuts.quick_add) : null;
  const toggle = shortcuts?.toggle_panel ? formatShortcut(shortcuts.toggle_panel) : null;

  // Watch for the Accessibility switch while that step is open.
  useEffect(() => {
    if (step !== 1 || status?.accessibility) return;
    const id = window.setInterval(onRefreshStatus, 1500);
    return () => window.clearInterval(id);
  }, [step, status?.accessibility, onRefreshStatus]);

  useEffect(() => {
    api
      .listModels()
      .then((ms) => {
        setModel(ms.find((m) => m.recommended) ?? ms[0] ?? null);
        const going = ms.find((m) => m.progress);
        if (going?.progress?.total) setProgress(Math.round((going.progress.downloaded / going.progress.total) * 100));
      })
      .catch(() => undefined);
    api
      .autostartEnabled()
      .then(setLogin)
      .catch(() => undefined);
    const sub = onModelDownload((e) => {
      if (e.state === "progress") setProgress(e.total ? Math.round((e.downloaded / e.total) * 100) : 0);
      if (e.state === "done") {
        setProgress(100);
        onRefreshStatus();
      }
      if (e.state === "failed") {
        setProgress(null);
        setModelError(e.error);
      }
      if (e.state === "cancelled") setProgress(null);
    });
    return () => void sub.then((u) => u());
  }, [onRefreshStatus]);

  // "Try it": a new task appearing means the capture worked.
  useEffect(() => {
    if (step !== 5) {
      baseline.current = null;
      return;
    }
    if (baseline.current === null) baseline.current = taskCount;
    else if (taskCount > baseline.current) setCaptured(true);
  }, [step, taskCount]);

  async function download() {
    if (!model) return;
    setModelError(null);
    setProgress(0);
    try {
      await api.downloadModel(model.id);
    } catch (e) {
      setProgress(null);
      setModelError(String(e));
    }
  }

  async function saveReminders() {
    try {
      await api.setAutostart(login);
      if (notify) await api.requestNotificationPermission();
      const s = await api.getSettings();
      onSettings(await api.setSettings({ ...s, show_on_start: showOnStart, notify: { ...s.notify, enabled: notify } }));
    } catch {
      // All of these can be changed later in Settings.
    }
    setStep(5);
  }

  if (hidden) return null;

  const next = (label = "Continue", to = step + 1, disabled = false) => (
    <button type="button" className="primary" disabled={disabled} onClick={() => setStep(to)}>
      {label}
    </button>
  );
  const back = step > 0 && (
    <button type="button" className="link-btn" onClick={() => setStep(step - 1)}>
      Back
    </button>
  );

  return (
    <section className="onboard" aria-label="Get started with Plucky">
      <div className="onboard-top">
        <ol className="onboard-steps" aria-label="Steps">
          {STEPS.map((s, i) => (
            <li key={s} className={i === step ? "on" : i < step ? "done" : ""} aria-current={i === step ? "step" : undefined}>
              <span className="sr-only">{s}</span>
            </li>
          ))}
        </ol>
        <span className="onboard-count">
          {step + 1} of {STEPS.length}
        </span>
      </div>

      {step === 0 && (
        <div className="onboard-body">
          <h2>Turn any text into a task</h2>
          <p>
            Select a message, an email or a web page, press <kbd>{capture}</kbd>, and Plucky writes the to-do with the
            right date — using a small model that runs on this Mac. Nothing you capture leaves it.
          </p>
          <p className="onboard-muted">This tour takes about two minutes and sets everything up.</p>
          <div className="onboard-actions">
            <button type="button" className="link-btn" onClick={onDone}>
              Skip tour
            </button>
            {next("Start the tour")}
          </div>
        </div>
      )}

      {step === 1 && (
        <div className="onboard-body">
          <h2>Let Plucky read selected text</h2>
          <p>
            macOS asks you to allow this once, in <b>System Settings → Privacy &amp; Security → Accessibility</b>. Turn
            on <b>Plucky</b> there. It only reads your selection when you press the shortcut.
          </p>
          {status?.accessibility ? (
            <p className="onboard-ok">✓ Access granted</p>
          ) : (
            <button type="button" className="ghost" onClick={() => void api.requestAccessibility().then(onRefreshStatus)}>
              Open System Settings
            </button>
          )}
          <div className="onboard-actions">
            {back}
            {next(status?.accessibility ? "Continue" : "I’ll do this later")}
          </div>
        </div>
      )}

      {step === 2 && (
        <div className="onboard-body">
          <h2>Download the on-device model</h2>
          {hasModel ? (
            <p className="onboard-ok">✓ {status?.active_model ?? "Model"} is ready</p>
          ) : (
            <>
              <p>
                {model
                  ? `${model.name} — about ${(model.approx_size_mb / 1000).toFixed(1)} GB, downloaded once.`
                  : "A small language model, downloaded once."}{" "}
                It keeps downloading while you finish the tour.
              </p>
              {progress !== null ? (
                <>
                  <div className="progress" aria-label="Download progress">
                    <div className="progress-bar" style={{ width: `${progress}%` }} />
                  </div>
                  <p className="progress-label">Downloading… {progress}%</p>
                </>
              ) : (
                <button type="button" className="primary" onClick={() => void download()} disabled={!model}>
                  Download recommended model
                </button>
              )}
              {modelError && <p className="model-error">{modelError}</p>}
              <p className="onboard-muted">Already have a GGUF file? Add it later in the Models tab.</p>
            </>
          )}
          <div className="onboard-actions">
            {back}
            {next()}
          </div>
        </div>
      )}

      {step === 3 && (
        <div className="onboard-body">
          <h2>Your shortcuts</h2>
          <p>They work in every app. Click one and press new keys to change it.</p>
          <div className="onboard-shortcuts">
            <ShortcutEditor shortcuts={shortcuts} onShortcuts={onShortcuts} compact />
          </div>
          <div className="onboard-actions">
            {back}
            {next()}
          </div>
        </div>
      )}

      {step === 4 && (
        <div className="onboard-body">
          <h2>Stay on top of it</h2>
          <div className="card-stack">
            <Toggle
              label="Remind me when tasks are due"
              hint="A notification with Done and Snooze buttons."
              checked={notify}
              onChange={setNotify}
            />
            <Toggle label="Open Plucky when I log in" hint="So the shortcuts always work." checked={login} onChange={setLogin} />
            <Toggle
              label="Show this panel each morning"
              hint="When your Mac starts or first wakes each day."
              checked={showOnStart}
              onChange={setShowOnStart}
            />
          </div>
          <p className="onboard-muted">Want tasks on your iPhone too? Connect Apple Reminders in the Connectors tab.</p>
          <div className="onboard-actions">
            {back}
            <button type="button" className="primary" onClick={() => void saveReminders()}>
              Continue
            </button>
          </div>
        </div>
      )}

      {step === 5 && (
        <div className="onboard-body">
          <h2>Try it in your browser</h2>
          {captured ? (
            <p className="onboard-ok">✓ Your first task is in Plucky. Nice!</p>
          ) : (
            <>
              <ol className="onboard-howto">
                <li>Open any web page in your browser.</li>
                <li>Select a sentence — something like a to-do or a date.</li>
                <li>
                  Press <kbd>{capture}</kbd>, or right-click it and choose <b>Add to Plucky</b>.
                </li>
                <li>A card drops down from the Plucky icon in the menu bar — check it and press Return.</li>
              </ol>
              {!status?.accessibility && (
                <p className="onboard-warn">
                  The shortcut needs Accessibility access.{" "}
                  <button type="button" className="link-btn" onClick={() => setStep(1)}>
                    Set it up
                  </button>
                </p>
              )}
              {!hasModel && (
                <p className="onboard-muted">
                  The model is still downloading, so this time you’ll type the task yourself.
                </p>
              )}
              <p className="onboard-wait">
                <span className="onboard-pulse" aria-hidden /> Waiting for your first capture…
              </p>
              <button type="button" className="link-btn" onClick={() => onTry(SAMPLE)}>
                No browser handy? Try it on sample text
              </button>
            </>
          )}
          <div className="onboard-actions">
            {back}
            {next(captured ? "Continue" : "Skip")}
          </div>
        </div>
      )}

      {step === 6 && (
        <div className="onboard-body">
          <h2>A quick look around</h2>
          <ul className="onboard-tips">
            <li>
              <b>Menu bar icon</b> — a calendar and today’s tasks. Drag a task onto another day to move it.
            </li>
            {quick && (
              <li>
                <kbd>{quick}</kbd> <b>Quick add</b> — type “pay rent friday 5pm #home” from anywhere.
              </li>
            )}
            {toggle && (
              <li>
                <kbd>{toggle}</kbd> <b>Show or hide Plucky</b> — even over full-screen apps.
              </li>
            )}
            <li>
              <b>Colored chips</b> — red is overdue, amber is due soon. Hover a task to snooze or add a description.
            </li>
            <li>
              <kbd>?</kbd> <b>Keyboard</b> — every key for the task list, like <kbd>Space</kbd> to complete.
            </li>
            <li>
              <b>Settings</b> — shortcuts, reminders, backups. Take this tour again from General.
            </li>
          </ul>
          <div className="onboard-actions">
            {back}
            <button type="button" className="primary" onClick={onDone}>
              Start using Plucky
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
