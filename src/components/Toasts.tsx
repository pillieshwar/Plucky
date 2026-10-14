import { useCallback, useEffect, useRef, useState } from "react";

export interface Toast {
  id: number;
  text: string;
  /** Undo, or another single follow-up action. */
  action?: { label: string; run: () => void | Promise<void> };
  tone?: "info" | "error";
}

const LIFETIME = 5500;

/**
 * A small queue of toasts. `undoLast` runs the newest toast's action (⌘Z),
 * so every undoable change gets a keyboard undo for free.
 */
export function useToasts() {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const seq = useRef(0);
  const timers = useRef(new Map<number, number>());

  const dismiss = useCallback((id: number) => {
    setToasts((ts) => ts.filter((t) => t.id !== id));
    const timer = timers.current.get(id);
    if (timer) window.clearTimeout(timer);
    timers.current.delete(id);
  }, []);

  const show = useCallback(
    (text: string, action?: Toast["action"], tone: Toast["tone"] = "info") => {
      const id = ++seq.current;
      // Keep at most three on screen.
      setToasts((ts) => [...ts.slice(-2), { id, text, action, tone }]);
      timers.current.set(
        id,
        window.setTimeout(() => dismiss(id), LIFETIME),
      );
      return id;
    },
    [dismiss],
  );

  const toastsRef = useRef(toasts);
  toastsRef.current = toasts;

  const undoLast = useCallback(() => {
    const last = [...toastsRef.current].reverse().find((t) => t.action);
    if (!last?.action) return false;
    dismiss(last.id);
    void last.action.run();
    return true;
  }, [dismiss]);

  useEffect(() => {
    const all = timers.current;
    return () => all.forEach((t) => window.clearTimeout(t));
  }, []);

  return { toasts, show, dismiss, undoLast };
}

export function Toasts({ toasts, onDismiss }: { toasts: Toast[]; onDismiss: (id: number) => void }) {
  if (!toasts.length) return null;
  return (
    <div className="toasts" role="status" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className={t.tone === "error" ? "toast error" : "toast"}>
          <span className="toast-text">{t.text}</span>
          {t.action && (
            <button
              type="button"
              className="toast-action"
              onClick={() => {
                onDismiss(t.id);
                void t.action!.run();
              }}
            >
              {t.action.label}
            </button>
          )}
          <button type="button" className="toast-close" aria-label="Dismiss" onClick={() => onDismiss(t.id)}>
            ×
          </button>
        </div>
      ))}
    </div>
  );
}
