import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CaptureCard, type CaptureState } from "./components/CaptureCard";
import { ModelsTab } from "./components/ModelsTab";
import { Onboarding } from "./components/Onboarding";
import { SettingsTab } from "./components/SettingsTab";
import { type RowCommand, TaskList } from "./components/TaskList";
import { Toasts, useToasts } from "./components/Toasts";
import { SearchIcon } from "./components/icons";
import {
  api,
  onCapture,
  onHighlightTask,
  onOpenTab,
  onPanelCollapsed,
  onShortcutsChanged,
  onTasksChanged,
  onUpdateStatus,
} from "./lib/api";
import { formatShortcut, type ShortcutSettings } from "./lib/shortcuts";
import { addDays, toISODate } from "./lib/dates";
import { groupTasks } from "./lib/grouping";
import { taskActions } from "./lib/taskActions";
import { matchesQuery, topTags } from "./lib/taskText";
import type { AppSettings, CaptureResult, NewTask, Status, Task, UpdateStatus } from "./lib/types";
import { safeLocale } from "./lib/locale";

const LOCALE = safeLocale();

type Tab = "tasks" | "models" | "settings";
const TABS: { id: Tab; label: string }[] = [
  { id: "tasks", label: "Tasks" },
  { id: "models", label: "Models" },
  { id: "settings", label: "Settings" },
];
const isTab = (t: string): t is Tab => TABS.some((x) => x.id === t);

const KEYS: [string, string][] = [
  ["↑ ↓", "Move between tasks"],
  ["Space", "Complete"],
  ["E / ↵", "Edit title"],
  ["D", "Date, time and repeat"],
  ["T · M · W", "Today · tomorrow · next week"],
  ["O", "Open where it came from"],
  ["⌫", "Delete"],
  ["⌘Z", "Undo"],
  ["/ or ⌘F", "Search"],
];

function typingIn(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el) return false;
  return el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT" || el.isContentEditable;
}

export default function App() {
  const [now, setNow] = useState(() => new Date());
  const [tasks, setTasks] = useState<Task[]>([]);
  const [capture, setCapture] = useState<CaptureState | null>(null);
  const [status, setStatus] = useState<Status | null>(null);
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [update, setUpdate] = useState<UpdateStatus>({ state: "idle" });
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("tasks");
  const [collapsed, setCollapsed] = useState(false);
  const [shortcuts, setShortcuts] = useState<ShortcutSettings | null>(null);
  const [highlight, setHighlight] = useState<number | null>(null);
  const [query, setQuery] = useState("");
  const [focusId, setFocusId] = useState<number | null>(null);
  const [command, setCommand] = useState<RowCommand | null>(null);
  const [showKeys, setShowKeys] = useState(false);
  const captureSeq = useRef(0);
  const statusRef = useRef<Status | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const today = toISODate(now);
  const { toasts, show, dismiss, undoLast } = useToasts();
  const actions = useMemo(() => taskActions(show, LOCALE), [show]);

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
    api
      .getShortcuts()
      .then(setShortcuts)
      .catch((e) => setError(String(e)));
    api
      .getSettings()
      .then(setSettings)
      .catch((e) => setError(String(e)));
    api
      .updateStatus()
      .then(setUpdate)
      .catch(() => undefined);
  }, [checkStatus]);

  // People upgrading with a model already set up skip the walkthrough.
  useEffect(() => {
    if (!settings || !status || settings.onboarding_done) return;
    if (status.active_model || status.engine === "ollama") {
      api
        .setSettings({ ...settings, onboarding_done: true })
        .then(setSettings)
        .catch(() => undefined);
    }
  }, [settings, status]);

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
    const source = result.source;
    const st = statusRef.current;
    if (st && st.engine === "bundled" && !st.active_model) {
      setCapture({
        phase: "manual",
        selection,
        source,
        error: "No model downloaded yet — add this one by hand, or get a model in the Models tab.",
      });
      return;
    }
    setCapture({ phase: "extracting", selection, source });
    try {
      const extractions = await api.extract(selection);
      if (seq !== captureSeq.current) return;
      if (extractions.length) setCapture({ phase: "review", selection, source, extractions });
      else setCapture({ phase: "manual", selection, source, error: "The model didn't find a task." });
    } catch (e) {
      if (seq === captureSeq.current) setCapture({ phase: "manual", selection, source, error: String(e) });
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
        setQuery("");
        setHighlight(id);
        setFocusId(id);
      }),
      onPanelCollapsed(setCollapsed),
      onUpdateStatus(setUpdate),
    ];
    return () => {
      subs.forEach((p) => void p.then((unlisten) => unlisten()));
    };
  }, [handleCapture, refresh]);

  const visible = useMemo(() => (query.trim() ? tasks.filter((t) => matchesQuery(t, query)) : tasks), [tasks, query]);
  const groups = useMemo(() => groupTasks(visible, now, LOCALE), [visible, now]);
  const flat = useMemo(() => groups.flatMap((g) => g.tasks), [groups]);
  const tags = useMemo(() => topTags(tasks), [tasks]);

  // Keyboard: Esc, undo, search and list navigation.
  const keyState = useRef({ flat, focusId, capture, tab, query, showKeys });
  keyState.current = { flat, focusId, capture, tab, query, showKeys };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const s = keyState.current;
      const mod = e.metaKey || e.ctrlKey;
      if (e.key === "Escape" && !e.defaultPrevented) {
        if (s.showKeys) setShowKeys(false);
        else if (s.capture) setCapture(null);
        else if (s.query && document.activeElement === searchRef.current) setQuery("");
        else void api.hidePanel();
        return;
      }
      if (mod && e.key.toLowerCase() === "z" && !e.shiftKey && !typingIn(e.target)) {
        if (undoLast()) e.preventDefault();
        return;
      }
      if (s.tab !== "tasks") return;
      if ((mod && e.key.toLowerCase() === "f") || (e.key === "/" && !typingIn(e.target))) {
        e.preventDefault();
        searchRef.current?.focus();
        searchRef.current?.select();
        return;
      }
      if (typingIn(e.target) || mod || e.altKey || s.capture) {
        if (e.key === "ArrowDown" && e.target === searchRef.current && s.flat.length) {
          e.preventDefault();
          searchRef.current?.blur();
          setFocusId(s.flat[0].id);
        }
        return;
      }
      const idx = s.flat.findIndex((t) => t.id === s.focusId);
      const current = idx >= 0 ? s.flat[idx] : null;
      const move = (d: number) => {
        if (!s.flat.length) return;
        const next = idx < 0 ? (d > 0 ? 0 : s.flat.length - 1) : Math.min(s.flat.length - 1, Math.max(0, idx + d));
        setFocusId(s.flat[next].id);
      };
      const n = Date.now();
      const key = e.key;
      const lower = key.toLowerCase();
      let handled = true;
      if (key === "ArrowDown" || lower === "j") move(1);
      else if (key === "ArrowUp" || lower === "k") move(-1);
      else if (key === "?") setShowKeys((v) => !v);
      else if (!current) handled = false;
      else if (key === " " || lower === "x") void actions.setDone(current, !current.done);
      else if (key === "Enter" || lower === "e") setCommand({ id: current.id, kind: "edit", n });
      else if (lower === "d") setCommand({ id: current.id, kind: "date", n });
      else if (lower === "t") void actions.reschedule(current, { due_date: toISODate(new Date()) });
      else if (lower === "m") void actions.reschedule(current, { due_date: toISODate(addDays(new Date(), 1)) });
      else if (lower === "w") void actions.reschedule(current, { due_date: toISODate(addDays(new Date(), 7)) });
      else if (lower === "o" && (current.source_url || current.source_bundle))
        void api.openSource(current.id).catch(actions.fail);
      else if (key === "Backspace" || key === "Delete") {
        move(1);
        void actions.remove(current);
      } else handled = false;
      if (handled) e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [actions, undoLast]);

  async function save(newTasks: NewTask[]) {
    try {
      for (const t of newTasks) await api.addTask(t);
      setCapture(null);
      show(newTasks.length === 1 ? "Task added" : `${newTasks.length} tasks added`);
    } catch (e) {
      setError(String(e));
    }
  }

  async function grantAccess() {
    await api.requestAccessibility();
    setCapture(null);
    void checkStatus();
  }

  async function saveSettings(next: AppSettings) {
    try {
      setSettings(await api.setSettings(next));
    } catch (e) {
      setError(String(e));
    }
  }

  function toggleTag(tag: string) {
    const words = query.split(/\s+/).filter(Boolean);
    const has = words.some((w) => w.toLowerCase() === tag);
    setQuery(has ? words.filter((w) => w.toLowerCase() !== tag).join(" ") : [...words, tag].join(" "));
    setTab("tasks");
  }

  const open = tasks.filter((t) => !t.done).length;
  const captureLabel = shortcuts ? formatShortcut(shortcuts.capture) : "…";
  const quickLabel = shortcuts?.quick_add ? formatShortcut(shortcuts.quick_add) : null;
  const dueToday = tasks.filter((t) => !t.done && t.due_date !== null && t.due_date <= today).length;
  const onboarding = !!settings && !!status && !settings.onboarding_done && !status.active_model && status.engine !== "ollama";
  const whatsNew =
    !!settings && !!status && settings.onboarding_done && !onboarding && settings.seen_version !== status.version;

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
                : `Pluck ${status?.version ?? ""}`}
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
            {t.id === "settings" && update.state === "ready" && <span className="tab-dot" aria-label="Update ready" />}
          </button>
        ))}
      </nav>

      {update.state === "ready" && tab !== "settings" && (
        <Banner tone="info" action={{ label: "Restart", run: () => api.installUpdate().catch((e) => setError(String(e))) }}>
          Pluck {update.version} is ready — restart to update.
        </Banner>
      )}
      {status && !status.accessibility && !capture && !onboarding && (
        <Banner tone="warn" action={{ label: "Grant access", run: grantAccess }}>
          Pluck needs Accessibility permission to read selected text.
        </Banner>
      )}
      {tab === "tasks" && status?.engine === "bundled" && !status.active_model && !onboarding && (
        <Banner tone="warn" action={{ label: "Get a model", run: () => setTab("models") }}>
          Download a model so Pluck can read your selections.
        </Banner>
      )}
      {whatsNew && tab === "tasks" && !capture && (
        <Banner
          tone="info"
          action={{
            label: "Got it",
            run: () => saveSettings({ ...settings!, seen_version: status!.version }),
          }}
        >
          <strong>New in {status!.version}:</strong> due-time reminders with snooze, {quickLabel ?? "quick add"} to type a
          task, links back to where a task came from, several tasks from one selection, and automatic updates.
        </Banner>
      )}
      {error && (
        <Banner tone="error" action={{ label: "Dismiss", run: () => setError(null) }}>
          {error}
        </Banner>
      )}

      {tab === "tasks" && onboarding && (
        <Onboarding
          status={status}
          captureShortcut={captureLabel}
          quickShortcut={quickLabel}
          onRefreshStatus={() => void checkStatus()}
          onOpenModels={() => setTab("models")}
          onTry={(text) => void handleCapture({ kind: "text", text, method: "service", source: null })}
          onDone={() =>
            void saveSettings({ ...settings!, onboarding_done: true, seen_version: status?.version ?? null })
          }
        />
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

      {tab === "tasks" && !onboarding && tasks.length > 0 && (
        <div className="search">
          <label className="search-box">
            <SearchIcon />
            <input
              ref={searchRef}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search or #tag"
              aria-label="Search tasks"
              spellCheck={false}
            />
            {query ? (
              <button type="button" className="search-clear" aria-label="Clear search" onClick={() => setQuery("")}>
                ×
              </button>
            ) : (
              <kbd>/</kbd>
            )}
          </label>
          {tags.length > 0 && (
            <div className="tag-row" aria-label="Tags">
              {tags.map((t) => {
                const on = query.toLowerCase().split(/\s+/).includes(t);
                return (
                  <button key={t} type="button" className={on ? "tag-chip on" : "tag-chip"} onClick={() => toggleTag(t)}>
                    {t}
                  </button>
                );
              })}
            </div>
          )}
        </div>
      )}

      <main className="panel-body">
        {tab === "tasks" && !onboarding && (
          <TaskList
            groups={groups}
            actions={actions}
            now={now}
            locale={LOCALE}
            shortcut={captureLabel}
            quickShortcut={quickLabel}
            highlight={highlight}
            focusId={focusId}
            onFocus={setFocusId}
            command={command}
            onTag={toggleTag}
            filtered={!!query.trim()}
            today={today}
          />
        )}
        {tab === "models" && <ModelsTab onChanged={checkStatus} />}
        {tab === "settings" && (
          <SettingsTab
            shortcuts={shortcuts}
            onShortcuts={setShortcuts}
            settings={settings}
            onSettings={setSettings}
            status={status}
            update={update}
            onError={setError}
          />
        )}
      </main>

      <Toasts toasts={toasts} onDismiss={dismiss} />

      {showKeys && (
        <div className="keys-sheet" role="dialog" aria-label="Keyboard shortcuts" onClick={() => setShowKeys(false)}>
          <div className="keys-card" onClick={(e) => e.stopPropagation()}>
            <h2>Keyboard</h2>
            <dl>
              {KEYS.map(([k, v]) => (
                <div key={k}>
                  <dt>
                    <kbd>{k}</kbd>
                  </dt>
                  <dd>{v}</dd>
                </div>
              ))}
            </dl>
            <p>
              Anywhere: <kbd>{captureLabel}</kbd> capture{quickLabel && <> · <kbd>{quickLabel}</kbd> quick add</>}
            </p>
          </div>
        </div>
      )}

      <footer className="panel-foot" data-tauri-drag-region>
        <span className="local-dot" aria-hidden /> On-device · <kbd>{captureLabel}</kbd> capture
        {quickLabel && (
          <>
            {" "}
            · <kbd>{quickLabel}</kbd> type
          </>
        )}
        <button type="button" className="foot-keys" onClick={() => setShowKeys(true)} title="Keyboard shortcuts">
          ?
        </button>
      </footer>
    </div>
  );
}

function Banner({
  tone,
  children,
  action,
}: {
  tone: "warn" | "error" | "info";
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
    <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
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
    <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
      <path d="M3 3l6 6M9 3l-6 6" />
    </svg>
  );
}
