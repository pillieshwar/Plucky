import { useId, useState } from "react";

/** A small (i): hover, focus or click to read more. Keeps settings pages short. */
export function InfoTip({ text, label = "More info" }: { text: string; label?: string }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  return (
    <span className="info-tip" onMouseEnter={() => setOpen(true)} onMouseLeave={() => setOpen(false)}>
      <button
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
        <span role="tooltip" id={id} className="info-pop">
          {text}
        </span>
      )}
    </span>
  );
}
