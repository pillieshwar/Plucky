import { useEffect, useState } from "react";
import { api, onModelDownload } from "../lib/api";
import { Toggle } from "./GeneralSettings";
import type { ModelInfo, Status } from "../lib/types";

interface Props {
  status: Status | null;
  captureShortcut: string;
  quickShortcut: string | null;
  onRefreshStatus: () => void;
  /** Run the sample text through a real capture. */
  onTry: (text: string) => void;
  onDone: () => void;
  onOpenModels: () => void;
}

const SAMPLE = "Hi! Could you send me the Q3 numbers by Friday 3pm? Thanks!";

const STEPS = ["Welcome", "Permission", "Model", "Reminders", "Try it"] as const;

/**
 * First run, in five short steps: what Pluck does, the one permission it
 * needs, a model, reminders, and a real capture of sample text.
 */
export function Onboarding({ status, captureShortcut, quickShortcut, onRefreshStatus, onTry, onDone, onOpenModels }: Props) {
  const [step, setStep] = useState(0);
  const [model, setModel] = useState<ModelInfo | null>(null);
  const [progress, setProgress] = useState<number | null>(null);
  const [modelError, setModelError] = useState<string | null>(null);
  const [notify, setNotify] = useState(true);
  const [login, setLogin] = useState(true);

  // Watch for the Accessibility switch while that step is open.
  useEffect(() => {
    if (step !== 1 || status?.accessibility) return;
    const id = window.setInterval(onRefreshStatus, 1500);
    return () => window.clearInterval(id);
  }, [step, status?.accessibility, onRefreshStatus]);

  useEffect(() => {
    api
      .listModels()
      .then((ms) => setModel(ms.find((m) => m.recommended) ?? ms[0] ?? null))
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

  async function finishReminders() {
    try {
      await api.setAutostart(login);
      if (notify) await api.requestNotificationPermission();
      const s = await api.getSettings();
      await api.setSettings({ ...s, notify: { ...s.notify, enabled: notify } });
    } catch {
      // Both can be changed later in Settings.
    }
    setStep(4);
  }

  const hasModel = !!status?.active_model || status?.engine === "ollama";

  return (
    <section className="onboard" aria-label="Get started with Pluck">
      <ol className="onboard-steps" aria-label="Steps">
        {STEPS.map((s, i) => (
          <li key={s} className={i === step ? "on" : i < step ? "done" : ""} aria-current={i === step ? "step" : undefined}>
            <span className="sr-only">{s}</span>
          </li>
        ))}
      </ol>

      {step === 0 && (
        <div className="onboard-body">
          <h2>Turn any text into a task</h2>
          <p>
            Select a message, an email or a web page, press <kbd>{captureShortcut}</kbd>, and Pluck writes the to-do —
            with the right date — using a small model that runs on this Mac. Nothing you capture leaves it.
          </p>
          <div className="onboard-actions">
            <button type="button" className="link-btn" onClick={onDone}>
              Skip setup
            </button>
            <button type="button" className="primary" onClick={() => setStep(1)}>
              Get started
            </button>
          </div>
        </div>
      )}

      {step === 1 && (
        <div className="onboard-body">
          <h2>Let Pluck read selected text</h2>
          <p>
            macOS asks you to allow this once, in System Settings → Privacy &amp; Security → Accessibility. Pluck only
            reads the selection when you press the shortcut.
          </p>
          {status?.accessibility ? (
            <p className="onboard-ok">✓ Access granted</p>
          ) : (
            <button type="button" className="ghost" onClick={() => void api.requestAccessibility().then(onRefreshStatus)}>
              Open System Settings
            </button>
          )}
          <div className="onboard-actions">
            <span />
            <button type="button" className="primary" onClick={() => setStep(2)}>
              Continue
            </button>
          </div>
        </div>
      )}

      {step === 2 && (
        <div className="onboard-body">
          <h2>Get the on-device model</h2>
          {hasModel ? (
            <p className="onboard-ok">✓ {status?.active_model ?? "Model"} is ready</p>
          ) : (
            <>
              <p>
                {model
                  ? `${model.name} by ${model.publisher} — about ${(model.approx_size_mb / 1000).toFixed(1)} GB, downloaded once.`
                  : "A small language model, downloaded once."}{" "}
                You can keep going while it downloads.
              </p>
              {progress !== null ? (
                <div className="progress" aria-label="Download progress">
                  <div className="progress-bar" style={{ width: `${progress}%` }} />
                </div>
              ) : (
                <div className="row-actions">
                  <button type="button" className="ghost" onClick={() => void download()} disabled={!model}>
                    Download
                  </button>
                  <button type="button" className="link-btn" onClick={onOpenModels}>
                    I already have a model file
                  </button>
                </div>
              )}
              {progress !== null && <p className="progress-label">{progress}%</p>}
              {modelError && <p className="model-error">{modelError}</p>}
            </>
          )}
          <div className="onboard-actions">
            <span />
            <button type="button" className="primary" onClick={() => setStep(3)}>
              Continue
            </button>
          </div>
        </div>
      )}

      {step === 3 && (
        <div className="onboard-body">
          <h2>Stay on top of it</h2>
          <div className="card-stack">
            <Toggle
              label="Remind me when tasks are due"
              hint="A notification with Done and Snooze, shown by this Mac."
              checked={notify}
              onChange={setNotify}
            />
            <Toggle
              label="Open Pluck when I log in"
              hint="So the shortcut always works."
              checked={login}
              onChange={setLogin}
            />
          </div>
          <div className="onboard-actions">
            <span />
            <button type="button" className="primary" onClick={() => void finishReminders()}>
              Continue
            </button>
          </div>
        </div>
      )}

      {step === 4 && (
        <div className="onboard-body">
          <h2>Try it</h2>
          <blockquote className="onboard-sample">{SAMPLE}</blockquote>
          <p>
            Anywhere else: select text and press <kbd>{captureShortcut}</kbd>
            {quickShortcut && (
              <>
                , or press <kbd>{quickShortcut}</kbd> to type a task
              </>
            )}
            . You can also right-click selected text and choose <strong>Add to Pluck</strong> (in some apps it’s under Services).
          </p>
          <div className="onboard-actions">
            <button type="button" className="link-btn" onClick={onDone}>
              Done
            </button>
            <button
              type="button"
              className="primary"
              disabled={!hasModel}
              title={hasModel ? undefined : "Waiting for the model to finish downloading"}
              onClick={() => {
                onDone();
                onTry(SAMPLE);
              }}
            >
              {hasModel ? "Capture this text" : "Model still downloading…"}
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
