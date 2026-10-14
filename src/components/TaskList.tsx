import { useState } from "react";
import { Calendar } from "./Calendar";
import { CalendarIcon } from "./CaptureCard";
import type { DayGroup } from "../lib/grouping";
import type { Task, TaskPatch } from "../lib/types";

interface Props {
  groups: DayGroup[];
  onUpdate: (id: number, patch: TaskPatch) => void;
  onDelete: (id: number) => void;
  now: Date;
  locale: string;
}

export function TaskList({ groups, onUpdate, onDelete, now, locale }: Props) {
  if (!groups.length) {
    return (
      <div className="empty">
        <p>No tasks yet.</p>
        <p>
          Select text in any app and press <kbd>{shortcutLabel()}</kbd>.
        </p>
      </div>
    );
  }
  return (
    <div className="groups">
      {groups.map((g) => (
        <section key={g.key} className={`group tone-${g.tone}`} aria-label={g.label}>
          <h2 className="day">
            {g.label}
            <span className="count">{g.tasks.length}</span>
          </h2>
          <ul>
            {g.tasks.map((t) => (
              <TaskRow key={t.id} task={t} onUpdate={onUpdate} onDelete={onDelete} now={now} locale={locale} />
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

function TaskRow({ task, onUpdate, onDelete, now, locale }: { task: Task } & Omit<Props, "groups">) {
  const [editing, setEditing] = useState(false);
  const [picking, setPicking] = useState(false);
  const [draft, setDraft] = useState(task.title);

  function commit() {
    setEditing(false);
    const title = draft.trim();
    if (title && title !== task.title) onUpdate(task.id, { title });
    else setDraft(task.title);
  }

  return (
    <li className={["task", task.done ? "done" : "", picking ? "picking" : ""].filter(Boolean).join(" ")}>
      <div className="task-row" title={task.source_text ?? undefined}>
        <input
          type="checkbox"
          checked={task.done}
          onChange={(e) => onUpdate(task.id, { done: e.target.checked })}
          aria-label={task.done ? `Mark “${task.title}” not done` : `Mark “${task.title}” done`}
        />
        {editing ? (
          <input
            className="task-edit"
            autoFocus
            value={draft}
            maxLength={200}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commit}
            onKeyDown={(e) => {
              if (e.key === "Enter") commit();
              if (e.key === "Escape") {
                e.stopPropagation();
                setDraft(task.title);
                setEditing(false);
              }
            }}
          />
        ) : (
          <span className="task-title" onDoubleClick={() => !task.done && setEditing(true)}>
            {task.title}
          </span>
        )}
        <div className="task-tools">
          <button
            type="button"
            className="task-date"
            title="Change date"
            aria-label="Change due date"
            aria-expanded={picking}
            onClick={() => setPicking((p) => !p)}
          >
            <CalendarIcon />
          </button>
          <button
            type="button"
            className="task-delete"
            aria-label={`Delete “${task.title}”`}
            onClick={() => onDelete(task.id)}
          >
            ×
          </button>
        </div>
      </div>
      {picking && (
        <Calendar
          value={task.due_date}
          onChange={(iso) => onUpdate(task.id, { due_date: iso })}
          onClose={() => setPicking(false)}
          now={now}
          locale={locale}
        />
      )}
    </li>
  );
}

export function shortcutLabel(): string {
  const mac = typeof navigator !== "undefined" && /Mac/i.test(navigator.platform);
  return mac ? "⌘⇧T" : "Ctrl+Shift+T";
}
