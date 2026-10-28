import { useRef, useState } from "react";
import { linesToSteps } from "../lib/lists";
import { useWords } from "../lib/words";
import type { ChecklistItem } from "../lib/types";

/**
 * A task's sub-tasks. Tick, edit (click the text), remove, and add — Enter adds
 * the next one; pasting several lines adds them all.
 */
export function Checklist({
  items,
  onChange,
  autoFocusAdd,
  readOnly,
  noAdd,
}: {
  items: ChecklistItem[];
  onChange: (items: ChecklistItem[]) => void;
  autoFocusAdd?: boolean;
  readOnly?: boolean;
  /** Just the list (shown under a task's row): tick, edit and remove, no add field. */
  noAdd?: boolean;
}) {
  const w = useWords();
  const [draft, setDraft] = useState("");
  const [editing, setEditing] = useState<number | null>(null);
  const addRef = useRef<HTMLInputElement>(null);

  function add(texts: string[]) {
    const clean = texts.map((t) => t.trim()).filter(Boolean);
    if (!clean.length) return;
    onChange([...items, ...clean.map((text) => ({ text, done: false }))]);
    setDraft("");
  }

  return (
    <div
      className="checklist"
      // Typing here is for the checklist, not the list's shortcuts.
      onKeyDown={(e) => e.stopPropagation()}
    >
      <ul>
        {items.map((it, i) => (
          <li key={i} className={it.done ? "step done" : "step"}>
            <button
              type="button"
              className="step-check"
              aria-pressed={it.done}
              aria-label={it.done ? `Mark “${it.text}” not done` : `Mark “${it.text}” done`}
              disabled={readOnly}
              onClick={() => onChange(items.map((x, j) => (j === i ? { ...x, done: !x.done } : x)))}
            >
              <svg width="9" height="9" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2.8">
                <path d="M3.5 8.5 6.5 11.5 12.5 4.5" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </button>
            {editing === i && !readOnly ? (
              <StepEditor
                initial={it.text}
                onDone={(text) => {
                  setEditing(null);
                  if (text === null || text === it.text) return;
                  onChange(text.trim() ? items.map((x, j) => (j === i ? { ...x, text: text.trim() } : x)) : items.filter((_, j) => j !== i));
                }}
              />
            ) : (
              <span className="step-text" onClick={() => !readOnly && setEditing(i)}>
                {it.text}
              </span>
            )}
            {!readOnly && (
              <button
                type="button"
                className="step-remove"
                aria-label={`Remove “${it.text}”`}
                title={`Remove ${w.step}`}
                onClick={() => onChange(items.filter((_, j) => j !== i))}
              >
                ×
              </button>
            )}
          </li>
        ))}
      </ul>
      {!readOnly && !noAdd && (
        <input
          ref={addRef}
          className="step-add"
          autoFocus={autoFocusAdd}
          value={draft}
          maxLength={200}
          placeholder={`Add a ${w.step}`}
          aria-label={`Add a ${w.step}`}
          onChange={(e) => setDraft(e.target.value)}
          onPaste={(e) => {
            const text = e.clipboardData.getData("text");
            if (/\n/.test(text.trim())) {
              e.preventDefault();
              add(linesToSteps(text));
            }
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              add([draft]);
            }
            if (e.key === "Escape") {
              setDraft("");
              addRef.current?.blur();
            }
          }}
          onBlur={() => add([draft])}
        />
      )}
    </div>
  );
}

function StepEditor({ initial, onDone }: { initial: string; onDone: (text: string | null) => void }) {
  const [value, setValue] = useState(initial);
  const done = useRef(false);
  const finish = (v: string | null) => {
    if (done.current) return;
    done.current = true;
    onDone(v);
  };
  return (
    <input
      className="step-edit"
      autoFocus
      value={value}
      maxLength={200}
      aria-label="Edit"
      onChange={(e) => setValue(e.target.value)}
      onBlur={() => finish(value)}
      onKeyDown={(e) => {
        if (e.key === "Enter") finish(value);
        if (e.key === "Escape") finish(null);
      }}
    />
  );
}

/** "2/5" — done steps of all. */
export function stepsLabel(items: ChecklistItem[]): string {
  return `${items.filter((i) => i.done).length}/${items.length}`;
}
