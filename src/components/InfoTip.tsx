import { useId, useRef, useState, type CSSProperties } from "react";

/** A small (i): hover, focus or click to read more. Keeps settings pages short. */
export function InfoTip({ text, label = "More info" }: { text: string; label?: string }) {
  const [open, setOpenRaw] = useState(false);
  const [at, setAt] = useState<CSSProperties>({});
  const btn = useRef<HTMLButtonElement>(null);
  const id = useId();
  // Fixed to the window, so a card's rounded edge never clips it.
  const setOpen = (v: boolean | ((o: boolean) => boolean)) =>
    setOpenRaw((o) => {
      const next = typeof v === "function" ? v(o) : v;
      const r = btn.current?.getBoundingClientRect();
      if (next && r) {
        const width = Math.min(300, window.innerWidth - 24);
        const left = Math.max(12, Math.min(r.left - 10, window.innerWidth - width - 12));
        setAt({ top: r.bottom + 6, left, maxWidth: width });
      }
      return next;
    });
  return (
    <span className="info-tip" onMouseEnter={() => setOpen(true)} onMouseLeave={() => setOpen(false)}>
      <button
        ref={btn}
        type="button"
        className="info-btn"
        aria-label={label}
        aria-describedby={open ? id : undefined}
        aria-expanded={open}
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          setOpen((o) => !o);
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onKeyDown={(e) => {
          if (e.key === "Escape") setOpen(false);
        }}
      >
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden>
          <circle cx="8" cy="8" r="6.3" />
          <path d="M8 7.2v4M8 4.9v.1" strokeLinecap="round" />
        </svg>
      </button>
      {open && (
        <span role="tooltip" id={id} className="info-pop" style={at}>
          {text}
        </span>
      )}
    </span>
  );
}
