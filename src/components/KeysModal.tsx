import { useEffect, useRef } from "react";
import type { ShortcutSettings } from "../lib/shortcuts";
import { ShortcutEditor } from "./ShortcutEditor";
import { Toggle } from "./GeneralSettings";

/**
 * Keyboard shortcuts, in one calm window: the ones that work anywhere on
 * the Mac (click a key to record a new one), then the keys inside TodoCity.
 */
export function KeysModal({
  keys,
  shortcuts,
  onShortcuts,
  doubleCopy,
  onDoubleCopy,
  onClose,
}: {
  keys: [string, string][];
  shortcuts: ShortcutSettings | null;
  onShortcuts: (s: ShortcutSettings) => void;
  doubleCopy: boolean;
  onDoubleCopy: (on: boolean) => void;
  onClose: () => void;
}) {
  const card = useRef<HTMLDivElement>(null);
  useEffect(() => {
    card.current?.focus();
    const esc = (e: KeyboardEvent) => {
      // A key being recorded takes Escape for itself.
      if (e.key === "Escape" && !document.querySelector(".keycap.recording")) {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", esc, true);
    return () => window.removeEventListener("keydown", esc, true);
  }, [onClose]);

  return (
    <div className="km-scrim" onClick={onClose}>
      <div className="km-card" role="dialog" aria-modal="true" aria-labelledby="km-title" tabIndex={-1} ref={card} onClick={(e) => e.stopPropagation()}>
        <header className="km-head">
          <span className="km-icon" aria-hidden>
            <KeyboardIcon />
          </span>
          <div>
            <h2 id="km-title">Keyboard shortcuts</h2>
            <p>Click a shortcut to record a new one.</p>
          </div>
          <button type="button" className="km-close" aria-label="Close" onClick={onClose}>
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden>
              <path d="M2.5 2.5l7 7M9.5 2.5l-7 7" />
            </svg>
          </button>
        </header>

        <div className="km-body">
          <section aria-labelledby="km-anywhere">
            <h3 id="km-anywhere" className="km-label">
              Anywhere on your Mac
            </h3>
            <div className="card-stack km-stack">
              <ShortcutEditor shortcuts={shortcuts} onShortcuts={onShortcuts} />
              <Toggle label="Press ⌘C twice to capture" hint="Copy as usual, then ⌘C again." checked={doubleCopy} onChange={onDoubleCopy} />
            </div>
          </section>

          <section aria-labelledby="km-inside">
            <h3 id="km-inside" className="km-label">
              In TodoCity
            </h3>
            <dl className="km-keys">
              {keys.map(([k, v]) => (
                <div key={k} className="km-key">
                  <dt>{v}</dt>
                  <dd>
                    {k.split(/ (?:·|\/|or) /).map((part, i) => (
                      <kbd key={i}>{part}</kbd>
                    ))}
                  </dd>
                </div>
              ))}
            </dl>
          </section>
        </div>
      </div>
    </div>
  );
}

export function KeyboardIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" aria-hidden>
      <rect x="1.5" y="3.5" width="13" height="9" rx="2" />
      <path d="M4 6.3h.01M6.4 6.3h.01M8.8 6.3h.01M11.2 6.3h.01M4 8.6h.01M6.4 8.6h.01M8.8 8.6h.01M11.2 8.6h.01M5.5 10.6h5" strokeWidth="1.6" />
    </svg>
  );
}
