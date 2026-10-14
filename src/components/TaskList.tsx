import { useState } from "react";
import type { DayGroup } from "../lib/grouping";
import type { Task, TaskPatch } from "../lib/types";

interface Props {
  groups: DayGroup[];
  onUpdate: (id: number, patch: TaskPatch) => void;
  onDelete: (id: number) => void;
}

export function TaskList({ groups, onUpdate, onDelete }: Props) {
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
              <TaskRow key={t.id} task={t} onUpdate={onUpdate} onDelete={onDelete} />
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

function TaskRow({ task, onUpdate, onDelete }: { task: Task; onUpdate: Props["onUpdate"]; onDelete: Props["onDelete"] }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(task.title);

  function commit() {
    setEditing(false);
    const title = draft.trim();
    if (title && title !== task.title) onUpdate(task.id, { title });
    else setDraft(task.title);
  }

  return (
    <li className={task.done ? "task done" : "task"} title={task.source_text ?? undefined}>
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
        <label className="task-date" title="Change date">
          <span aria-hidden>◷</span>
          <input
            type="date"
            value={task.due_date ?? ""}
            aria-label="Change due date"
            onChange={(e) => onUpdate(task.id, { due_date: e.target.value || null })}
          />
        </label>
        <button type="button" className="task-delete" aria-label={`Delete “${task.title}”`} onClick={() => onDelete(task.id)}>
          ×
        </button>
      </div>
    </li>
  );
}

export function shortcutLabel(): string {
  const mac = typeof navigator !== "undefined" && /Mac/i.test(navigator.platform);
  return mac ? "⌘⇧T" : "Ctrl+Shift+T";
}
