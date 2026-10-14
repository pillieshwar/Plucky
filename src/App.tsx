import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CaptureCard, type CaptureState } from "./components/CaptureCard";
import { ModelsTab } from "./components/ModelsTab";
import { TaskList, shortcutLabel } from "./components/TaskList";
import { api, onCapture, onOpenTab, onTasksChanged } from "./lib/api";
import { toISODate } from "./lib/dates";
import { groupTasks } from "./lib/grouping";
import type { CaptureResult, NewTask, Status, Task, TaskPatch } from "./lib/types";

const LOCALE = navigator.language;

type Tab = "tasks" | "models";

export default function App() {
  const [now, setNow] = useState(() => new Date());
  const [tasks, setTasks] = useState<Task[]>([]);
  const [capture, setCapture] = useState<CaptureState | null>(null);
  const [status, setStatus] = useState<Status | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("tasks");
  const captureSeq = useRef(0);
  const statusRef = useRef<Status | null>(null);
  const onboarded = useRef(false);
  const today = toISODate(now);

  const refresh = useCallback(async () => {
    try {
      setTasks(await api.listTasks(today));
    } catch (e) {
      setError(String(e));
    }
  }, [today]);

  const checkStatus = useCallback(async () => {
    try {
      const s = await api.status();
      statusRef.current = s;
      setStatus(s);
      // First run: no model yet, so start on the Models tab.
      if (!onboarded.current) {
        onboarded.current = true;
        if (s.engine === "bundled" && !s.active_model) setTab("models");
      }
    } catch (e) {
      setError(String(e));
    }
  }, []);

  // Keep "today" correct across midnight and after sleep.
  useEffect(() => {
    const tick = () => setNow(new Date());
    const id = window.setInterval(tick, 60_000);
    window.addEventListener("focus", tick);
    return () => {
      window.clearInterval(id);
      window.removeEventListener("focus", tick);
    };
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    void checkStatus();
  }, [checkStatus]);

  const handleCapture = useCallback(async (result: CaptureResult) => {
    const seq = ++captureSeq.current;
    if (result.kind !== "text") {
      setCapture({ phase: "notice", result });
      return;
    }
    setTab("tasks");
    const selection = result.text;
    const st = statusRef.current;
    if (st && st.engine === "bundled" && !st.active_model) {
      setCapture({
        phase: "manual",
        selection,
        error: "No model downloaded yet — add this one by hand, or get a model in the Models tab.",
      });
      return;
    }
    setCapture({ phase: "extracting", selection });
    try {
      const extraction = await api.extract(selection);
      if (seq === captureSeq.current) setCapture({ phase: "review", selection, extraction });
    } catch (e) {
      if (seq === captureSeq.current) setCapture({ phase: "manual", selection, error: String(e) });
    }
  }, []);

  useEffect(() => {
    const subs = [
      onCapture((r) => void handleCapture(r)),
      onTasksChanged(() => void refresh()),
      onOpenTab((t) => setTab(t === "models" ? "models" : "tasks")),
    ];
    return () => {
      subs.forEach((p) => void p.then((unlisten) => unlisten()));
    };
  }, [handleCapture, refresh]);

  // Esc closes the panel when nothing is being edited.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !e.defaultPrevented) {
        if (capture) setCapture(null);
        else void api.hidePanel();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [capture]);

  async function save(task: NewTask) {
    try {
      await api.addTask(task);
      setCapture(null);
    } catch (e) {
      setError(String(e));
    }
  }

  async function update(id: number, patch: TaskPatch) {
    try {
      await api.updateTask(id, patch);
    } catch (e) {
      setError(String(e));
    }
  }

  async function remove(id: number) {
    try {
      await api.deleteTask(id);
    } catch (e) {
      setError(String(e));
    }
  }

  async function grantAccess() {
    await api.requestAccessibility();
    setCapture(null);
    void checkStatus();
  }

  const groups = useMemo(() => groupTasks(tasks, now, LOCALE), [tasks, now]);
  const open = tasks.filter((t) => !t.done).length;

  return (
    <div className="panel">
      <header className="panel-head" data-tauri-drag-region>
        <div data-tauri-drag-region>
          <h1>{tab === "tasks" ? "Tasks" : "Models"}</h1>
          <p className="sub">
            {tab === "tasks"
              ? `${now.toLocaleDateString(LOCALE, { weekday: "long", month: "long", day: "numeric" })} · ${open} open`
              : status?.active_model
                ? `Using ${status.active_model}`
                : "No model yet"}
          </p>
        </div>
        <button className="icon" onClick={() => void api.hidePanel()} aria-label="Hide panel" title="Hide (Esc)">
          ×
        </button>
      </header>

      <nav className="tabs" role="tablist" aria-label="Sections">
        {(["tasks", "models"] as const).map((t) => (
          <button
            key={t}
            role="tab"
            aria-selected={tab === t}
            className={tab === t ? "tab on" : "tab"}
            onClick={() => setTab(t)}
          >
            {t === "tasks" ? "Tasks" : "Models"}
          </button>
        ))}
      </nav>

      {status && !status.accessibility && !capture && (
        <Banner tone="warn" action={{ label: "Grant access", run: grantAccess }}>
          Pluck needs Accessibility permission to read selected text.
        </Banner>
      )}
      {tab === "tasks" && status?.engine === "bundled" && !status.active_model && (
        <Banner tone="warn" action={{ label: "Get a model", run: () => setTab("models") }}>
          Download a model so Pluck can read your selections.
        </Banner>
      )}
      {error && (
        <Banner tone="error" action={{ label: "Dismiss", run: () => setError(null) }}>
          {error}
        </Banner>
      )}

      {tab === "tasks" && capture && (
        <CaptureCard state={capture} now={now} onSave={save} onCancel={() => setCapture(null)} onGrantAccess={grantAccess} />
      )}

      <main className="panel-body">
        {tab === "tasks" ? (
          <TaskList groups={groups} onUpdate={update} onDelete={remove} />
        ) : (
          <ModelsTab onChanged={checkStatus} />
        )}
      </main>

      <footer className="panel-foot">
        <span className="local-dot" aria-hidden /> On-device · <kbd>{shortcutLabel()}</kbd> to capture
      </footer>
    </div>
  );
}

function Banner({
  tone,
  children,
  action,
}: {
  tone: "warn" | "error";
  children: ReactNode;
  action?: { label: string; run: () => void | Promise<void> };
}) {
  return (
    <div className={`banner ${tone}`} role={tone === "error" ? "alert" : "status"}>
      <p>{children}</p>
      {action && (
        <button type="button" onClick={() => void action.run()}>
          {action.label}
        </button>
      )}
    </div>
  );
}
