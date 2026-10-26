import { useCallback, useEffect, useMemo, useState } from "react";
import { api, onTasksChanged } from "../lib/api";
import { relativeLabel, toISODate } from "../lib/dates";
import type { TaskActions } from "../lib/taskActions";
import { matchesQuery, sourceLabel } from "../lib/taskText";
import type { Task } from "../lib/types";
import { FolderIcon } from "./ProjectPicker";
import { clockHour12 } from "../lib/schedule";

const PAGE = 80;

/**
 * Everything you've finished, newest first, by the day it was done. Untick a
 * task to bring it back.
 */
export function Logbook({
  actions,
  now,
  locale,
  query,
  onOpenProject,
}: {
  actions: TaskActions;
  now: Date;
  locale: string;
  query: string;
  onOpenProject: (name: string) => void;
}) {
  const [items, setItems] = useState<Task[]>([]);
  const [more, setMore] = useState(false);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      const page = await api.logbook(null, PAGE);
      setItems(page);
      setMore(page.length === PAGE);
    } catch (e) {
      actions.fail(e);
    } finally {
      setLoading(false);
    }
  }, [actions]);

  useEffect(() => {
    void load();
    const sub = onTasksChanged(() => void load());
    return () => void sub.then((u) => u());
  }, [load]);

  async function loadMore() {
    const last = items[items.length - 1]?.completed_at ?? null;
    try {
      const page = await api.logbook(last, PAGE);
      setItems((xs) => [...xs, ...page]);
      setMore(page.length === PAGE);
    } catch (e) {
      actions.fail(e);
    }
  }

  const shown = useMemo(() => (query.trim() ? items.filter((t) => matchesQuery(t, query)) : items), [items, query]);
  const days = useMemo(() => {
    const out: { day: string; tasks: Task[] }[] = [];
    for (const t of shown) {
      const day = t.completed_at ? toISODate(new Date(t.completed_at)) : "";
      const last = out[out.length - 1];
      if (last && last.day === day) last.tasks.push(t);
      else out.push({ day, tasks: [t] });
    }
    return out;
  }, [shown]);

  if (!loading && !items.length) {
    return (
      <div className="empty">
        <p className="empty-big">Nothing finished yet</p>
        <p>Completed tasks are kept here, newest first.</p>
      </div>
    );
  }

  return (
    <div className="groups logbook">
      {days.map((d) => (
        <section key={d.day} className="group tone-done" aria-label={d.day}>
          <h2 className="day">
            {d.day ? relativeLabel(d.day, now, locale) : "Earlier"}
            <span className="count">{d.tasks.length}</span>
          </h2>
          <ul>
            {d.tasks.map((t) => (
              <li key={t.id} className="task done log-row">
                <div className="task-row">
                  <button
                    type="button"
                    className="check on"
                    onClick={() => void actions.setDone(t, false)}
                    aria-label={`Bring back “${t.title}”`}
                    title="Not done — bring it back"
                  >
                    <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2.4">
                      <path d="M3.5 8.5 6.5 11.5 12.5 4.5" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                  </button>
                  <div className="task-main">
                    <span className="task-title">{t.title}</span>
                    <div className="task-meta">
                      {t.completed_at && (
                        <span>{new Date(t.completed_at).toLocaleTimeString(locale, { hour: "numeric", minute: "2-digit", hour12: clockHour12() })}</span>
                      )}
                      {t.project && (
                        <button type="button" className="meta-project" onClick={() => onOpenProject(t.project!)}>
                          <FolderIcon /> {t.project}
                        </button>
                      )}
                      {sourceLabel(t) && <span>{sourceLabel(t)}</span>}
                    </div>
                  </div>
                </div>
              </li>
            ))}
          </ul>
        </section>
      ))}
      {more && !query.trim() && (
        <button type="button" className="log-more" onClick={() => void loadMore()}>
          Show earlier
        </button>
      )}
    </div>
  );
}
