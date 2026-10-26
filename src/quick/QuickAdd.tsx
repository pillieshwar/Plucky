import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, onQuickShown } from "../lib/api";
import { dayOrderForLocale, relativeLabel } from "../lib/dates";
import { findSchedule, repeatLabel, timeLabel } from "../lib/schedule";
import { tagsOf } from "../lib/taskText";
import { CalendarIcon, ClockIcon, RepeatIcon } from "../components/icons";
import { safeLocale } from "../lib/locale";

const LOCALE = safeLocale();
const ORDER = dayOrderForLocale(LOCALE);

/**
 * The quick-add bar: type a task in plain words, see how Todo City reads it,
 * press Return. Dates are read on this Mac, instantly, without the model.
 */
export default function QuickAdd() {
  const [text, setText] = useState("");
  const [now, setNow] = useState(() => new Date());
  const [saved, setSaved] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [openKey, setOpenKey] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const reset = useCallback(() => {
    setText("");
    setSaved(null);
    setError(null);
    setNow(new Date());
    setOpenKey((k) => k + 1);
    window.setTimeout(() => inputRef.current?.focus(), 0);
  }, []);

  useEffect(() => {
    const sub = onQuickShown(reset);
    inputRef.current?.focus();
    return () => void sub.then((u) => u());
  }, [reset]);

  const found = useMemo(() => findSchedule(text, now, ORDER), [text, now]);
  const tags = tagsOf(found.title);
  const title = found.title || text.trim();

  async function submit() {
    if (!title || busy) return;
    setBusy(true);
    setError(null);
    try {
      await api.addTask({
        title,
        due_date: found.date,
        due_time: found.date ? found.time : null,
        recurrence: found.repeat,
        source_text: null,
      });
      setSaved(found.date ? `Added for ${relativeLabel(found.date, now, LOCALE).toLowerCase()}` : "Added");
      window.setTimeout(() => void api.hideQuickAdd(), 650);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="qa-wrap" key={openKey}>
      <form
        className={saved ? "qa saved" : "qa"}
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.preventDefault();
            void api.hideQuickAdd();
          }
        }}
      >
        <div className="qa-line">
          <span className="qa-mark" aria-hidden>
            {saved ? "✓" : "+"}
          </span>
          <input
            ref={inputRef}
            className="qa-input"
            value={saved ?? text}
            readOnly={!!saved}
            onChange={(e) => setText(e.target.value)}
            placeholder="New task — “pay rent friday 5pm #home”"
            aria-label="New task"
            spellCheck={false}
            autoComplete="off"
          />
          <kbd className="qa-enter">↵</kbd>
        </div>
        {!saved && text.trim() && (
          <div className="qa-preview" aria-live="polite">
            <span className="qa-title">{title}</span>
            <span className="qa-chips">
              {found.date ? (
                <span className="qa-chip on">
                  <CalendarIcon /> {relativeLabel(found.date, now, LOCALE)}
                </span>
              ) : (
                <span className="qa-chip">No date</span>
              )}
              {found.time && (
                <span className="qa-chip on">
                  <ClockIcon /> {timeLabel(found.time, LOCALE)}
                </span>
              )}
              {found.repeat && (
                <span className="qa-chip on">
                  <RepeatIcon /> {repeatLabel(found.repeat)}
                </span>
              )}
              {tags.map((t) => (
                <span key={t} className="qa-chip tag">
                  {t}
                </span>
              ))}
            </span>
          </div>
        )}
        {error && <p className="qa-error">{error}</p>}
        {!text.trim() && !saved && (
          <p className="qa-hint">Try “call mom tomorrow 6pm”, “water plants every monday”, “send invoice eom #work”.</p>
        )}
      </form>
    </div>
  );
}
