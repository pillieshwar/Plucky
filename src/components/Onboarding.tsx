import { useEffect, useRef, useState } from "react";
import { api, onModelDownload } from "../lib/api";
import { ShortcutEditor } from "./ShortcutEditor";
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
  /** Run text through a real capture (the review card). */
  onTry: (text: string) => void;
  onDone: () => void;
}

const SAMPLE = "Could you send me the Q3 numbers by Friday 3pm? Thanks!";
const STEPS = ["Model", "Shortcut", "Try it"] as const;

/**
 * The first-run tour, in three steps: pick the on-device model, pick how to
 * capture, and capture something. Everything else has sensible defaults and
 * lives behind the gear. Shown on first launch and from Preferences.
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
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [chosen, setChosen] = useState<string | null>(null);
  const [progress, setProgress] = useState<number | null>(null);
  const [modelError, setModelError] = useState<string | null>(null);
  const [captured, setCaptured] = useState(false);
  const baseline = useRef<number | null>(null);
  const lastCopy = useRef(0);

  const hasModel = !!status?.active_model || status?.engine === "ollama";
  const doubleCopy = settings?.double_copy ?? true;
  const combo = shortcuts ? formatShortcut(shortcuts.capture) : "…";
  const how = doubleCopy ? "⌘C twice" : combo;

  useEffect(() => {
    api
      .listModels()
      .then((ms) => {
        const sorted = [...ms].sort((a, b) => Number(b.recommended) - Number(a.recommended) || a.rank - b.rank);
        setModels(sorted.slice(0, 3));
        setChosen((c) => c ?? sorted[0]?.id ?? null);
        const going = ms.find((m) => m.progress);
        if (going?.progress?.total) setProgress(Math.round((going.progress.downloaded / going.progress.total) * 100));
      })
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

  // The key combo needs Accessibility; watch for it being granted.
  useEffect(() => {
    if (step !== 1 || doubleCopy || status?.accessibility) return;
    const id = window.setInterval(onRefreshStatus, 1500);
    return () => window.clearInterval(id);
  }, [step, doubleCopy, status?.accessibility, onRefreshStatus]);

  // "Try it": a new task appearing means the capture worked.
  useEffect(() => {
    if (step !== 2) {
      baseline.current = null;
      return;
    }
    if (baseline.current === null) baseline.current = taskCount;
    else if (taskCount > baseline.current) setCaptured(true);
  }, [step, taskCount]);

  // In the tour, copying the sample twice here works too (TodoCity ignores
  // copies made inside itself everywhere else).
  useEffect(() => {
    if (step !== 2) return;
    const onCopy = () => {
      const now = Date.now();
      const text = window.getSelection()?.toString().trim() ?? "";
      if (doubleCopy && text && now - lastCopy.current < 700) {
        lastCopy.current = 0;
        onTry(text);
      } else lastCopy.current = now;
    };
    document.addEventListener("copy", onCopy);
    return () => document.removeEventListener("copy", onCopy);
  }, [step, doubleCopy, onTry]);

  async function download() {
    if (!chosen) return;
    setModelError(null);
    setProgress(0);
    try {
      await api.downloadModel(chosen);
    } catch (e) {
      setProgress(null);
      setModelError(String(e));
    }
  }

  async function setDoubleCopy(on: boolean) {
    try {
      const s = await api.getSettings();
      onSettings(await api.setSettings({ ...s, double_copy: on }));
    } catch {
      // Can be changed later in Preferences.
    }
  }

  async function finish() {
    // Reminders are on by default; ask for permission to show them now.
    try {
      await api.requestNotificationPermission();
    } catch {
      // Preferences can do this later.
    }
    onDone();
  }

  if (hidden) return null;

  const back = step > 0 && (
    <button type="button" className="link-btn" onClick={() => setStep(step - 1)}>
      Back
    </button>
  );

  return (
    <section className="onboard" aria-label="Get started with TodoCity">
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
        <button type="button" className="link-btn" onClick={onDone}>
          Skip
        </button>
      </div>

      {step === 0 && (
        <div className="onboard-body">
          <h2>Pick your on-device model</h2>
          <p>TodoCity reads text and writes the to-do with a small AI model that runs on this Mac. Nothing leaves it.</p>
          {hasModel ? (
            <p className="onboard-ok">✓ {status?.active_model ?? "A model"} is ready</p>
          ) : progress !== null ? (
            <>
              <div className="progress" aria-label="Download progress">
                <div className="progress-bar" style={{ width: `${progress}%` }} />
              </div>
              <p className="progress-label">Downloading… {progress}% — you can carry on meanwhile.</p>
            </>
          ) : (
            <div className="onboard-choices" role="radiogroup" aria-label="Model">
              {models.map((m) => (
                <button
                  key={m.id}
                  type="button"
                  role="radio"
                  aria-checked={chosen === m.id}
                  className={chosen === m.id ? "onboard-choice on" : "onboard-choice"}
                  onClick={() => setChosen(m.id)}
                >
                  <span className="oc-title">
                    {m.name}
                    {m.recommended && <span className="oc-badge">Best for this Mac</span>}
                  </span>
                  <span className="oc-hint">
                    {(m.approx_size_mb / 1000).toFixed(1)} GB · needs {m.min_ram_gb} GB memory
                  </span>
                </button>
              ))}
            </div>
          )}
          {modelError && <p className="model-error">{modelError}</p>}
          <div className="onboard-actions">
            <span />
            {hasModel || progress !== null ? (
              <button type="button" className="primary" onClick={() => setStep(1)}>
                Continue
              </button>
            ) : (
              <button
                type="button"
                className="primary"
                disabled={!chosen}
                onClick={() => {
                  void download();
                  setStep(1);
                }}
              >
                Download and continue
              </button>
            )}
          </div>
        </div>
      )}

      {step === 1 && (
        <div className="onboard-body">
          <h2>How do you want to capture?</h2>
          <div className="onboard-choices" role="radiogroup" aria-label="Capture with">
            <button
              type="button"
              role="radio"
              aria-checked={doubleCopy}
              className={doubleCopy ? "onboard-choice on" : "onboard-choice"}
              onClick={() => void setDoubleCopy(true)}
            >
              <span className="oc-title">
                Press <kbd>⌘C</kbd> twice<span className="oc-badge">Easiest</span>
              </span>
              <span className="oc-hint">Copy as usual, press ⌘C again — TodoCity picks it up. Works in every app.</span>
            </button>
            <button
              type="button"
              role="radio"
              aria-checked={!doubleCopy}
              className={!doubleCopy ? "onboard-choice on" : "onboard-choice"}
              onClick={() => void setDoubleCopy(false)}
            >
              <span className="oc-title">
                A shortcut, like <kbd>{combo}</kbd>
              </span>
              <span className="oc-hint">Select text and press it — no copying needed.</span>
            </button>
          </div>
          {!doubleCopy && (
            <>
              <div className="onboard-shortcuts">
                <ShortcutEditor shortcuts={shortcuts} onShortcuts={onShortcuts} compact />
              </div>
              {status?.accessibility ? (
                <p className="onboard-ok">✓ TodoCity can read selected text</p>
              ) : (
                <p className="onboard-warn">
                  The shortcut needs Accessibility access.{" "}
                  <button type="button" className="link-btn" onClick={() => void api.requestAccessibility().then(onRefreshStatus)}>
                    Allow in System Settings
                  </button>
                </p>
              )}
            </>
          )}
          <div className="onboard-actions">
            {back}
            <button type="button" className="primary" onClick={() => setStep(2)}>
              Continue
            </button>
          </div>
        </div>
      )}

      {step === 2 && (
        <div className="onboard-body">
          <h2>Try it</h2>
          {captured ? (
            <p className="onboard-ok">✓ Your first task is in TodoCity.</p>
          ) : (
            <>
              <p>
                Select the message below, then press <kbd>{how}</kbd>. Check the card that drops down and press Return.
              </p>
              <blockquote className="onboard-sample" tabIndex={0}>
                {SAMPLE}
              </blockquote>
              {!hasModel && <p className="onboard-muted">The model is still downloading, so this time you’ll type the task yourself.</p>}
              <button type="button" className="link-btn" onClick={() => onTry(SAMPLE)}>
                Or just use the sample
              </button>
            </>
          )}
          <div className="onboard-actions">
            {back}
            <button type="button" className="primary" onClick={() => void finish()}>
              {captured ? "Start using TodoCity" : "Finish"}
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
