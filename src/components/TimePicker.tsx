import { useEffect, useMemo, useRef, useState } from "react";
import { timeLabel } from "../lib/schedule";

interface Props {
  value: string | null;
  /** `HH:MM`, or null for "no time". */
  onChange: (time: string | null) => void;
  locale: string;
  /** Today: offer "In 1 hour" and start the list near now. */
  now?: Date;
  /** Text when no time is set. */
  placeholder?: string;
  /** Focus the field (and so open the list) when it appears. */
  autoFocus?: boolean;
}

const pad = (n: number) => String(n).padStart(2, "0");

/** Every quarter hour of the day. */
const SLOTS = Array.from({ length: 96 }, (_, i) => `${pad(Math.floor(i / 4))}:${pad((i % 4) * 15)}`);

/** One hour from now, rounded up to the next quarter hour. */
export function inAnHour(now: Date): string {
  const d = new Date(now.getTime() + 60 * 60 * 1000);
  const q = Math.ceil(d.getMinutes() / 15) * 15;
  d.setMinutes(q, 0, 0);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * A time typed loosely: "9", "9am", "9:30", "930", "9.30 pm", "21:15",
 * "noon", "midnight". Bare 1–6 means the afternoon ("3" → 15:00), as people
 * rarely plan tasks for 3 at night. Returns `HH:MM`, or null.
 */
export function parseTimeInput(text: string): string | null {
  const s = text.trim().toLowerCase().replace(/\s+/g, "");
  if (!s) return null;
  if (s === "noon") return "12:00";
  if (s === "midnight") return "00:00";
  const m = /^(\d{1,2})(?:[:.h]?(\d{2}))?(a|am|p|pm)?$/.exec(s);
  if (!m) return null;
  let h = Number(m[1]);
  const min = m[2] ? Number(m[2]) : 0;
  const ap = m[3]?.[0];
  if (min > 59) return null;
  if (ap) {
    if (h < 1 || h > 12) return null;
    if (ap === "p" && h < 12) h += 12;
    if (ap === "a" && h === 12) h = 0;
  } else {
    if (h > 23) return null;
    if (!m[2] && h >= 1 && h <= 6) h += 12;
  }
  return `${pad(h)}:${pad(min)}`;
}

/**
 * Pick a time: a field you can type into ("3pm", "9:30") with a list of
 * every quarter hour below it, plus "No time" and "In 1 hour". Arrow keys
 * move through the list; Return picks.
 */
export function TimePicker({ value, onChange, locale, now, placeholder = "Add a time", autoFocus }: Props) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [hi, setHi] = useState(0);
  const listRef = useRef<HTMLUListElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const soon = now ? inAnHour(now) : null;
  const typed = parseTimeInput(text);
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (autoFocus) inputRef.current?.focus();
  }, [autoFocus]);

  type Item = { key: string; time: string | null; label: string; hint?: string };
  const items = useMemo<Item[]>(() => {
    const head: Item[] = [{ key: "none", time: null, label: "No time" }];
    if (soon) head.push({ key: "soon", time: soon, label: "In 1 hour", hint: timeLabel(soon, locale) });
    if (typed && !SLOTS.includes(typed)) head.push({ key: "typed", time: typed, label: timeLabel(typed, locale) });
    const q = text.trim().toLowerCase();
    const slots = SLOTS.map((t) => ({ key: t, time: t, label: timeLabel(t, locale) }));
    // While typing, keep the list to times that start like what's typed.
    const shown = q && !typed ? slots.filter((s) => s.label.toLowerCase().replace(/\s/g, "").startsWith(q.replace(/\s/g, ""))) : slots;
    return [...(q ? head.filter((h) => h.key === "typed") : head), ...shown];
  }, [soon, typed, text, locale]);

  // Where the list starts: the chosen time, what's typed, or the next
  // quarter hour after now (else 9 AM).
  const anchor = useMemo(() => {
    const target =
      typed ??
      value ??
      (now ? SLOTS.find((t) => t >= `${pad(now.getHours())}:${pad(now.getMinutes())}`) : null) ??
      "09:00";
    const i = items.findIndex((it) => it.time === target);
    return i >= 0 ? i : 0;
  }, [items, typed, value, now]);

  useEffect(() => {
    if (!open) return;
    setHi(anchor);
  }, [open, anchor]);

  useEffect(() => {
    if (!open) return;
    const el = listRef.current?.children[hi] as HTMLElement | undefined;
    el?.scrollIntoView({ block: "nearest" });
  }, [open, hi]);

  // Close when clicking elsewhere.
  useEffect(() => {
    if (!open) return;
    const off = (e: MouseEvent) => {
      if (!boxRef.current?.contains(e.target as Node)) {
        setOpen(false);
        setText("");
      }
    };
    document.addEventListener("mousedown", off);
    return () => document.removeEventListener("mousedown", off);
  }, [open]);

  function pick(time: string | null) {
    onChange(time);
    setOpen(false);
    setText("");
  }

  const shownValue = open ? text : value ? timeLabel(value, locale) : "";

  return (
    <div className={value ? "time-select set" : "time-select"} ref={boxRef}>
      <ClockGlyph />
      <input
        ref={inputRef}
        value={shownValue}
        placeholder={open ? "Type a time… 3pm, 9:30" : placeholder}
        aria-label="Time"
        role="combobox"
        aria-expanded={open}
        aria-autocomplete="list"
        spellCheck={false}
        onFocus={() => setOpen(true)}
        onClick={() => setOpen(true)}
        onChange={(e) => {
          setText(e.target.value);
          setOpen(true);
        }}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown" || e.key === "ArrowUp") {
            e.preventDefault();
            setOpen(true);
            setHi((h) => Math.max(0, Math.min(items.length - 1, h + (e.key === "ArrowDown" ? 1 : -1))));
          } else if (e.key === "Enter") {
            e.preventDefault();
            e.stopPropagation();
            if (typed) pick(typed);
            else if (open && items[hi]) pick(items[hi].time);
          } else if (e.key === "Escape") {
            if (open) {
              e.preventDefault();
              e.stopPropagation();
              setOpen(false);
              setText("");
              (e.target as HTMLInputElement).blur();
            }
          } else if (e.key === "Tab") {
            if (typed) pick(typed);
            else setOpen(false);
          }
        }}
      />
      {value && !open && (
        <button type="button" className="ts-clear" aria-label="Remove the time" onClick={() => onChange(null)}>
          ×
        </button>
      )}
      {open && (
        <ul className="ts-list" role="listbox" ref={listRef}>
          {items.map((it, i) => (
            <li
              key={it.key}
              role="option"
              aria-selected={it.time === value}
              className={[i === hi ? "hi" : "", it.time === value ? "on" : "", it.key === "none" || it.key === "soon" ? "special" : ""].filter(Boolean).join(" ")}
              onMouseEnter={() => setHi(i)}
              onMouseDown={(e) => {
                e.preventDefault();
                pick(it.time);
              }}
            >
              <span>{it.label}</span>
              {it.hint && <span className="ts-hint">{it.hint}</span>}
            </li>
          ))}
          {!items.length && <li className="ts-empty">Type a time like “3pm” or “9:30”</li>}
        </ul>
      )}
    </div>
  );
}

function ClockGlyph() {
  return (
    <svg className="ts-icon" width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden>
      <circle cx="8" cy="8" r="6" />
      <path d="M8 4.8V8l2.2 1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
