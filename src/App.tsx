import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CaptureCard, type CaptureState } from "./components/CaptureCard";
import { ModelsTab } from "./components/ModelsTab";
import { SettingsTab } from "./components/SettingsTab";
import { TaskList } from "./components/TaskList";
import {
  api,
  onCapture,
  onHighlightTask,
  onOpenTab,
  onPanelCollapsed,
  onShortcutsChanged,
  onTasksChanged,
} from "./lib/api";
import { formatShortcut, type ShortcutSettings } from "./lib/shortcuts";
import { toISODate } from "./lib/dates";
import { groupTasks } from "./lib/grouping";
import type { CaptureResult, NewTask, Status, Task, TaskPatch } from "./lib/types";

const LOCALE = navigator.language;

type Tab = "tasks" | "models" | "settings";
const TABS: { id: Tab; label: string }[] = [
  { id: "tasks", label: "Tasks" },
  { id: "models", label: "Models" },
  { id: "settings", label: "Settings" },
];
const isTab = (t: string): t is Tab => TABS.some((x) => x.id === t);

export default function App() {
  const [now, setNow] = useState(() => new Date());
  const [tasks, setTasks] = useState<Task[]>([]);
  const [capture, setCapture] = useState<CaptureState | null>(null);
  const [status, setStatus] = useState<Status | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("tasks");
  const [collapsed, setCollapsed] = useState(false);
  const [shortcuts, setShortcuts] = useState<ShortcutSettings | null>(null);
  const [highlight, setHighlight] = useState<number | null>(null);
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

  useEffect(() => {
    api
      .getShortcuts()
      .then(setShortcuts)
      .catch((e) => setError(String(e)));
  }, []);

  // A task picked from the menu bar flashes briefly.
  useEffect(() => {
    if (highlight === null) return;
    const t = window.setTimeout(() => setHighlight(null), 1800);
    return () => window.clearTimeout(t);
  }, [highlight]);

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
      onOpenTab((t) => setTab(isTab(t) ? t : "tasks")),
      onShortcutsChanged(setShortcuts),
      onHighlightTask((id) => {
        setTab("tasks");
        setHighlight(id);
      }),
      onPanelCollapsed(setCollapsed),
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
  const captureLabel = shortcuts ? formatShortcut(shortcuts.capture) : "…";
  const dueToday = tasks.filter((t) => !t.done && t.due_date !== null && t.due_date <= today).length;

  function minimize(next: boolean) {
    setCollapsed(next);
    api.setPanelCollapsed(next).catch((e) => setError(String(e)));
  }

  const controls = (
    <div className="win-controls">
      <button
        className="icon"
        onClick={() => minimize(!collapsed)}
        aria-label={collapsed ? "Expand panel" : "Minimize panel"}
        title={collapsed ? "Expand" : "Minimize"}
      >
        {collapsed ? <ExpandIcon /> : <MinimizeIcon />}
      </button>
      <button className="icon" onClick={() => void api.hidePanel()} aria-label="Hide panel" title="Hide (Esc)">
        <CloseIcon />
      </button>
    </div>
  );

  if (collapsed) {
    return (
      <div className="panel collapsed">
        <header className="mini" data-tauri-drag-region onDoubleClick={() => minimize(false)}>
          <DragGrip />
          <span className="mini-title" data-tauri-drag-region>
            Pluck
          </span>
          <span className="mini-meta" data-tauri-drag-region>
            {open} open{dueToday ? ` · ${dueToday} due` : ""}
          </span>
          {controls}
        </header>
      </div>
    );
  }

  return (
    <div className="panel">
      <header className="panel-head" data-tauri-drag-region>
        <DragGrip />
        <div className="head-text" data-tauri-drag-region>
          <h1 data-tauri-drag-region>{TABS.find((t) => t.id === tab)?.label}</h1>
          <p className="sub" data-tauri-drag-region>
            {tab === "tasks"
              ? `${now.toLocaleDateString(LOCALE, { weekday: "long", month: "long", day: "numeric" })} · ${open} open`
              : tab === "models"
                ? status?.active_model
                  ? `Using ${status.active_model}`
                  : "No model yet"
                : "Shortcuts and panel"}
          </p>
        </div>
        {controls}
      </header>

      <nav className="tabs" role="tablist" aria-label="Sections">
        {TABS.map((t) => (
          <button
            key={t.id}
            role="tab"
            aria-selected={tab === t.id}
            className={tab === t.id ? "tab on" : "tab"}
            onClick={() => setTab(t.id)}
          >
            {t.label}
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
        <CaptureCard
          state={capture}
          now={now}
          onSave={save}
          onCancel={() => setCapture(null)}
          onGrantAccess={grantAccess}
        />
      )}

      <main className="panel-body">
        {tab === "tasks" && (
          <TaskList
            groups={groups}
            onUpdate={update}
            onDelete={remove}
            now={now}
            locale={LOCALE}
            shortcut={captureLabel}
            highlight={highlight}
          />
        )}
        {tab === "models" && <ModelsTab onChanged={checkStatus} />}
        {tab === "settings" && <SettingsTab shortcuts={shortcuts} onShortcuts={setShortcuts} />}
      </main>

      <footer className="panel-foot" data-tauri-drag-region>
        <span className="local-dot" aria-hidden /> On-device · <kbd>{captureLabel}</kbd> to capture
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

function DragGrip() {
  return (
    <span className="grip" data-tauri-drag-region title="Drag to move" aria-hidden>
      <svg width="8" height="14" viewBox="0 0 8 14" fill="currentColor" style={{ pointerEvents: "none" }}>
        <circle cx="2" cy="2" r="1.2" />
        <circle cx="6" cy="2" r="1.2" />
        <circle cx="2" cy="7" r="1.2" />
        <circle cx="6" cy="7" r="1.2" />
        <circle cx="2" cy="12" r="1.2" />
        <circle cx="6" cy="12" r="1.2" />
      </svg>
    </span>
  );
}

function MinimizeIcon() {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 12 12"
      aria-hidden
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
    >
      <path d="M2.5 6h7" />
    </svg>
  );
}

function ExpandIcon() {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 12 12"
      aria-hidden
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M3 7.5 6 4.5l3 3" />
    </svg>
  );
}

function CloseIcon() {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 12 12"
      aria-hidden
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
    >
      <path d="M3 3l6 6M9 3l-6 6" />
    </svg>
  );
}
