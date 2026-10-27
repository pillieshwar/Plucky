import { useEffect, useRef, useState } from "react";
import { api } from "../lib/api";
import { activeMode } from "../lib/modes";
import type { AppSettings } from "../lib/types";

/**
 * Which mode this Mac is in (Work, Personal…), and a menu to switch. Shown
 * at the top of full screen's sidebar, in the side panel and in the
 * menu-bar dropdown.
 */
export function ModeSwitch({
  settings,
  onSettings,
  onEdit,
  variant = "chip",
}: {
  settings: AppSettings | null;
  onSettings: (s: AppSettings) => void;
  /** Open Preferences → Modes. */
  onEdit?: () => void;
  /** "side": full width in the sidebar; "chip": small, in a header. */
  /** side: the full-screen sidebar; chip: a header pill; icon: just the icon, where room is tight. */
  variant?: "side" | "chip" | "icon";
}) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const modes = settings?.modes ?? [];
  const mode = activeMode(settings);

  useEffect(() => {
    if (!open) return;
    const off = (e: PointerEvent) => {
      if (!box.current?.contains(e.target as Node)) setOpen(false);
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        setOpen(false);
      }
    };
    document.addEventListener("pointerdown", off, true);
    document.addEventListener("keydown", key, true);
    return () => {
      document.removeEventListener("pointerdown", off, true);
      document.removeEventListener("keydown", key, true);
    };
  }, [open]);

  if (!settings || !modes.length) return null;

  const pick = (id: string | null) => {
    setOpen(false);
    void api
      .setViewMode(id)
      .then(onSettings)
      .catch(() => undefined);
  };

  return (
    <div className={`mode-switch mode-${variant}${mode ? " on" : ""}`} ref={box}>
      <button
        type="button"
        className="mode-btn"
        aria-haspopup="menu"
        aria-expanded={open}
        title={mode ? `${mode.name} mode: only its projects are shown. Click to switch.` : "Showing everything. Click to pick a mode."}
        onClick={() => setOpen((o) => !o)}
      >
        <span className="mode-icon" aria-hidden>
          {mode ? mode.icon : "◎"}
        </span>
        <span className={variant === "icon" ? "mode-name sr-only" : "mode-name"}>
          {mode ? (variant === "side" ? mode.name : `${mode.name} mode`) : "Everything"}
        </span>
        <svg className="mode-caret" width="9" height="9" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2.2" aria-hidden>
          <path d="M3.5 6 8 10.5 12.5 6" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      {open && (
        <div className="mode-menu" role="menu" aria-label="Mode">
          <p className="mode-menu-label">Show on this Mac</p>
          {modes.map((m, i) => (
            <button
              key={m.id}
              type="button"
              role="menuitemradio"
              aria-checked={mode?.id === m.id}
              className={mode?.id === m.id ? "mode-item on" : "mode-item"}
              onClick={() => pick(m.id)}
              autoFocus={mode ? mode.id === m.id : i === 0}
            >
              <span className="mode-icon" aria-hidden>
                {m.icon}
              </span>
              <span className="mode-item-name">{m.name}</span>
              {i < 9 && <kbd className="mode-key">⌃⌥{i + 1}</kbd>}
            </button>
          ))}
          <button type="button" role="menuitemradio" aria-checked={!mode} className={!mode ? "mode-item on" : "mode-item"} onClick={() => pick(null)}>
            <span className="mode-icon" aria-hidden>
              ◎
            </span>
            <span className="mode-item-name">Everything</span>
            <kbd className="mode-key">⌃⌥0</kbd>
          </button>
          {onEdit && (
            <>
              <span className="mode-sep" role="separator" />
              <button
                type="button"
                role="menuitem"
                className="mode-item edit"
                onClick={() => {
                  setOpen(false);
                  onEdit();
                }}
              >
                Edit modes…
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}
