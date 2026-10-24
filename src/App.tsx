import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CaptureCard, type CaptureState } from "./components/CaptureCard";
import { ModelsTab } from "./components/ModelsTab";
import { ConnectorsTab } from "./components/ConnectorsTab";
import { Onboarding } from "./components/Onboarding";
import { processCapture } from "./lib/capture";
import { UpdateBanner } from "./components/UpdateBanner";
import { SettingsTab } from "./components/SettingsTab";
import { type RowCommand, TaskList } from "./components/TaskList";
import { Toasts, useToasts } from "./components/Toasts";
import { SearchIcon } from "./components/icons";
import { ViewSwitch } from "./components/ViewSwitch";
import { WeekView } from "./components/WeekView";
import { weekStartForLocale } from "./lib/calendar";
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
import { addDays, parseISODate, toISODate } from "./lib/dates";
import { groupTasks } from "./lib/grouping";
import { groupByHeading, headingsOf, projectList, projectOf, tasksForList, type ListId } from "./lib/lists";
import { ListPicker } from "./components/ListPicker";
import { Logbook } from "./components/Logbook";
import type { ProjectInfo } from "./components/ProjectPicker";
import { ProjectHeader } from "./components/ProjectHeader";
import { BatchBar } from "./components/BatchBar";
import { taskActions } from "./lib/taskActions";
import { dueNow } from "./lib/due";
import { DueNowCard } from "./components/DueNowCard";
import { AddTaskForm } from "./components/AddTaskForm";
import { relativeLabel } from "./lib/dates";
import { timeLabel } from "./lib/schedule";
import { matchesQuery, topTags } from "./lib/taskText";
import type { AppSettings, CaptureResult, NewTask, ProjectSummary, Status, Task, UpdateStatus } from "./lib/types";
import { safeLocale } from "./lib/locale";

const LOCALE = safeLocale();

type Tab = "tasks" | "connectors" | "models" | "settings";
const TABS: { id: Tab; label: string }[] = [
  { id: "tasks", label: "Tasks" },
  { id: "connectors", label: "Connectors" },
  { id: "models", label: "Models" },
  { id: "settings", label: "Preferences" },
];
const isTab = (t: string): t is Tab => TABS.some((x) => x.id === t);

type View = "list" | "week";
function savedView(): View {
  try {
    return localStorage.getItem("pluck.view") === "week" ? "week" : "list";
  } catch {
    return "list";
  }
}

const KEYS: [string, string][] = [
  ["↑ ↓", "Move between tasks"],
  ["Space", "Complete"],
  ["E / ↵", "Edit title"],
  ["D", "Date, time and repeat"],
  ["T · M · W", "Today · tomorrow · next week"],
  ["O", "Open where it came from"],
  ["⌫", "Delete"],
  ["⌘Z", "Undo"],
  ["⌘-click · ⇧-click", "Select several (⌘A all)"],
  ["S", "Snooze"],
  ["N", "Description"],
  ["A", "Add a task"],
  ["F", "Today only (focus)"],
  ["C", "Steps (checklist)"],
  ["P", "Move to a project"],
  ["V", "List or week view"],
  ["← →", "Day before / after (week view)"],
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
  // Which list: All, Today, Someday, Logbook or a project. Remembered per Mac.
  const [list, setList] = useState<ListId>(() => {
    try {
      const saved = localStorage.getItem("pluck.list");
      if (saved) return saved as ListId;
      return localStorage.getItem("pluck.focusToday") === "1" ? "today" : "all";
    } catch {
      return "all";
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem("pluck.list", list);
    } catch {
      // Storage unavailable: the choice lasts this session.
    }
  }, [list]);
  const focusToday = list === "today";
  const setFocusToday = (f: boolean | ((v: boolean) => boolean)) =>
    setList((l) => ((typeof f === "function" ? f(l === "today") : f) ? "today" : "all"));
  const [projectStats, setProjectStats] = useState<ProjectSummary[]>([]);
  // Tasks selected for batch actions, and where a Shift-click range starts.
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const anchor = useRef<number | null>(null);
  // Tasks as a list, or the week in hour blocks. Remembered per Mac.
  const [view, setView] = useState<View>(savedView);
  useEffect(() => {
    try {
      localStorage.setItem("pluck.view", view);
    } catch {
      // Storage unavailable: the choice lasts this session.
    }
  }, [view]);
  const [planDay, setPlanDay] = useState(() => toISODate(new Date()));
  const weekStart = useMemo(() => weekStartForLocale(LOCALE), []);
  const captureSeq = useRef(0);
  const statusRef = useRef<Status | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const today = toISODate(now);
  const { toasts, show, dismiss, undoLast } = useToasts();
  // The add-task form at the top of the list.
  const [adding, setAdding] = useState(false);
  // The heading new tasks go under, when adding from a project's heading.
  const [addHeading, setAddHeading] = useState<string | null>(null);
  const actions = useMemo(() => taskActions(show, LOCALE), [show]);

  const refresh = useCallback(async () => {
    try {
      api.listProjects().then(setProjectStats, () => undefined);
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
  const refreshStatus = useCallback(() => void checkStatus(), [checkStatus]);

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

  // The tour opens on a first run (nothing set up yet) and stays open until
  // it's finished or skipped, even once the model arrives mid-way.
  const [tour, setTour] = useState(false);
  const tourDecided = useRef(false);
  useEffect(() => {
    if (tourDecided.current || !settings || !status) return;
    tourDecided.current = true;
    if (!settings.onboarding_done && !status.active_model && status.engine !== "ollama") setTour(true);
  }, [settings, status]);

  // People upgrading with a model already set up skip the walkthrough.
  useEffect(() => {
    if (!settings || !status || settings.onboarding_done || tour) return;
    if (status.active_model || status.engine === "ollama") {
      api
        .setSettings({ ...settings, onboarding_done: true })
        .then(setSettings)
        .catch(() => undefined);
    }
  }, [settings, status, tour]);

  // A task picked from the menu bar flashes briefly.
  useEffect(() => {
    if (highlight === null) return;
    const t = window.setTimeout(() => setHighlight(null), 1800);
    return () => window.clearTimeout(t);
  }, [highlight]);

  const handleCapture = useCallback(async (result: CaptureResult) => {
    const seq = ++captureSeq.current;
    if (result.kind === "text") setTab("tasks");
    await processCapture(result, statusRef.current, setCapture, () => seq === captureSeq.current);
  }, []);

  useEffect(() => {
    const subs = [
      onCapture((r) => void handleCapture(r)),
      onTasksChanged(() => void refresh()),
      onOpenTab((t) => setTab(isTab(t) ? t : "tasks")),
      onShortcutsChanged(setShortcuts),
      onHighlightTask((id) => {
        setTab("tasks");
        setView("list");
        setList("all");
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

  const visible = useMemo(
    () => tasksForList(tasks, list, today).filter((t) => !query.trim() || matchesQuery(t, query)),
    [tasks, query, list, today],
  );
  const firing = useMemo(() => dueNow(tasks, now), [tasks, now]);
  const viewedProject = projectOf(list);
  const groups = useMemo(
    () => (list === "logbook" ? [] : viewedProject !== null ? groupByHeading(visible) : groupTasks(visible, now, LOCALE)),
    [visible, now, list, viewedProject],
  );
  const listCounts = useMemo(
    () => ({
      all: tasksForList(tasks, "all", today).filter((t) => !t.done).length,
      today: tasksForList(tasks, "today", today).filter((t) => !t.done).length,
      someday: tasks.filter((t) => !t.done && t.someday).length,
    }),
    [tasks, today],
  );
  const projectInfos: ProjectInfo[] = useMemo(() => {
    const names = new Set([...projectStats.map((p) => p.name), ...tasks.flatMap((t) => (t.project ? [t.project] : []))]);
    return [...names].sort((a, b) => a.localeCompare(b)).map((name) => ({ name, headings: headingsOf(tasks, name) }));
  }, [projectStats, tasks]);
  const openProject = (name: string) => {
    setView("list");
    setTab("tasks");
    setQuery("");
    setList(projectList(name));
  };
  const flat = useMemo(() => groups.flatMap((g) => g.tasks), [groups]);
  // The selection only holds tasks still on screen.
  useEffect(() => {
    setSelected((sel) => {
      if (!sel.size) return sel;
      const ids = new Set(flat.filter((t) => !t.done).map((t) => t.id));
      const next = new Set([...sel].filter((id) => ids.has(id)));
      return next.size === sel.size ? sel : next;
    });
  }, [flat]);
  useEffect(() => setSelected(new Set()), [list, view, tab]);
  const selectTask = (id: number, mode: "toggle" | "range") => {
    setSelected((sel) => {
      const next = new Set(sel);
      const from = anchor.current ?? focusId;
      if (mode === "range" && from !== null) {
        const ids = flat.filter((t) => !t.done).map((t) => t.id);
        const a = ids.indexOf(from);
        const b = ids.indexOf(id);
        if (a >= 0 && b >= 0) {
          for (const x of ids.slice(Math.min(a, b), Math.max(a, b) + 1)) next.add(x);
          return next;
        }
      }
      if (next.has(id)) next.delete(id);
      else next.add(id);
      anchor.current = id;
      return next;
    });
  };
  const selectedTasks = useMemo(() => flat.filter((t) => selected.has(t.id)), [flat, selected]);
  const tags = useMemo(() => topTags(tasks), [tasks]);

  // Keyboard: Esc, undo, search and list navigation.
  const keyState = useRef({ flat, focusId, capture, tab, query, showKeys, view, selectedTasks });
  keyState.current = { flat, focusId, capture, tab, query, showKeys, view, selectedTasks };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const s = keyState.current;
      const mod = e.metaKey || e.ctrlKey;
      if (e.key === "Escape" && !e.defaultPrevented) {
        if (s.showKeys) setShowKeys(false);
        else if (s.selectedTasks.length) setSelected(new Set());
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
      if (s.view === "week" && !typingIn(e.target) && !mod && !e.altKey && !s.capture) {
        // The week has no list to move through; its own few keys.
        const k = e.key.toLowerCase();
        let used = true;
        if (k === "v") setView("list");
        else if (k === "a") setAdding(true);
        else if (e.key === "?") setShowKeys((v) => !v);
        else if (k === "t") setPlanDay(toISODate(new Date()));
        else if (e.key === "ArrowLeft") setPlanDay((d) => toISODate(addDays(parseISODate(d), -1)));
        else if (e.key === "ArrowRight") setPlanDay((d) => toISODate(addDays(parseISODate(d), 1)));
        else used = false;
        if (used) e.preventDefault();
        return;
      }
      // ⌘A selects every open task shown.
      if (mod && e.key.toLowerCase() === "a" && !typingIn(e.target) && s.view === "list" && !s.capture) {
        e.preventDefault();
        setSelected(new Set(s.flat.filter((t) => !t.done).map((t) => t.id)));
        return;
      }
      // With a selection, the usual keys act on all of it.
      const sel = s.selectedTasks;
      if (sel.length && !typingIn(e.target) && !mod && !e.altKey && !s.capture) {
        const k = e.key.toLowerCase();
        const iso = (n: number) => toISODate(addDays(new Date(), n));
        const what = sel.length === 1 ? "1 task" : `${sel.length} tasks`;
        let used = true;
        if (e.key === " " || k === "x") void actions.completeMany(sel).then(() => setSelected(new Set()));
        else if (e.key === "Backspace" || e.key === "Delete") void actions.removeMany(sel).then(() => setSelected(new Set()));
        else if (k === "t") void actions.batch(sel, { due_date: iso(0) }, `Moved ${what} to today`);
        else if (k === "m") void actions.batch(sel, { due_date: iso(1) }, `Moved ${what} to tomorrow`);
        else if (k === "w") void actions.batch(sel, { due_date: iso(7) }, `Moved ${what} to next week`);
        else used = false;
        if (used) {
          e.preventDefault();
          return;
        }
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
      if ((key === "ArrowDown" || key === "ArrowUp") && e.shiftKey) {
        // Shift+↑/↓ grows the selection from the focused task.
        const d = key === "ArrowDown" ? 1 : -1;
        const open = s.flat.filter((t) => !t.done);
        const i = open.findIndex((t) => t.id === s.focusId);
        const next = open[Math.min(open.length - 1, Math.max(0, i + d))];
        if (next) {
          setSelected((sel) => {
            const n2 = new Set(sel);
            if (i >= 0) n2.add(open[i].id);
            n2.add(next.id);
            return n2;
          });
          setFocusId(next.id);
        }
      } else if (key === "ArrowDown" || lower === "j") move(1);
      else if (key === "ArrowUp" || lower === "k") move(-1);
      else if (key === "?") setShowKeys((v) => !v);
      else if (lower === "f") setFocusToday((v) => !v);
      else if (lower === "a") setAdding(true);
      else if (lower === "v") setView("week");
      else if (!current) handled = false;
      else if (key === " " || lower === "x") void actions.setDone(current, !current.done);
      else if (key === "Enter" || lower === "e") setCommand({ id: current.id, kind: "edit", n });
      else if (lower === "d") setCommand({ id: current.id, kind: "date", n });
      else if (lower === "s") setCommand({ id: current.id, kind: "snooze", n });
      else if (lower === "n") setCommand({ id: current.id, kind: "notes", n });
      else if (lower === "c") setCommand({ id: current.id, kind: "steps", n });
      else if (lower === "p") setCommand({ id: current.id, kind: "project", n });
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

  async function save(task: NewTask) {
    try {
      await api.addTask(task);
      setCapture(null);
      show("Task added");
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
  const onboarding = tour;

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
            Plucky
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
              ? `${now.toLocaleDateString(LOCALE, { weekday: "short", month: "short", day: "numeric" })} · ${open} open`
              : tab === "connectors"
                ? "Work with apps on this Mac"
                : tab === "models"
                ? status?.active_model
                  ? `Using ${status.active_model}`
                  : "No model yet"
                : `Plucky ${status?.version ?? ""}`}
          </p>
        </div>
        {tab === "tasks" && !onboarding && (
          <ViewSwitch
            value={view}
            options={[
              ["list", "List"],
              ["week", "Week"],
            ]}
            onChange={(v) => {
              setView(v);
              setAdding(false);
            }}
            label="Show tasks as (V)"
          />
        )}
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

      {tab !== "settings" && <UpdateBanner update={update} onError={setError} />}
      {status && !status.accessibility && !capture && !onboarding && (
        <Banner tone="warn" action={{ label: "Grant access", run: grantAccess }}>
          Plucky needs Accessibility permission to read selected text.
        </Banner>
      )}
      {tab === "tasks" && status?.engine === "bundled" && !status.active_model && !onboarding && (
        <Banner tone="warn" action={{ label: "Get a model", run: () => setTab("models") }}>
          Download a model so Plucky can read your selections.
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
          shortcuts={shortcuts}
          onShortcuts={setShortcuts}
          settings={settings}
          onSettings={setSettings}
          taskCount={tasks.length}
          hidden={!!capture}
          onRefreshStatus={refreshStatus}
          onTry={(text) => void handleCapture({ kind: "text", text, method: "service", source: null })}
          onDone={() => {
            setTour(false);
            if (settings) void saveSettings({ ...settings, onboarding_done: true, seen_version: status?.version ?? null });
          }}
        />
      )}

      {tab === "tasks" && !onboarding && !capture && view === "list" && (
        <DueNowCard tasks={firing} actions={actions} now={now} locale={LOCALE} compact />
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

      {tab === "tasks" && !onboarding && view === "list" && tasks.length > 0 && (
        <div className="search">
          <div className="search-line">
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
          <ListPicker
            value={list}
            onChange={(l) => {
              setList(l);
              setAdding(false);
            }}
            counts={listCounts}
            projects={projectStats}
          />
          <button
            type="button"
            className={adding ? "add-task-btn on" : "add-task-btn"}
            onClick={() => setAdding((a) => !a)}
            aria-expanded={adding}
            title="Add a task (A)"
          >
            <span aria-hidden>+</span> Add task
          </button>
          </div>
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

      <main className={tab === "tasks" && !onboarding && view === "week" ? "panel-body week" : "panel-body"}>
        {tab === "tasks" && !onboarding && view === "week" && (
          <WeekView
            tasks={tasks}
            day={planDay}
            onDay={setPlanDay}
            now={now}
            locale={LOCALE}
            weekStart={weekStart}
            actions={actions}
            adding={adding}
            onAdding={setAdding}
            onAdd={async (task) => {
              try {
                await api.addTask(task);
                show(
                  task.due_time && task.due_date === planDay
                    ? `Added at ${timeLabel(task.due_time, LOCALE)}`
                    : task.due_date
                      ? `Added for ${relativeLabel(task.due_date, new Date(), LOCALE).toLowerCase()}`
                      : "Task added",
                );
              } catch (e) {
                setError(String(e));
                throw e;
              }
            }}
            onOpen={(t) => {
              setView("list");
              setAdding(false);
              setQuery("");
              if (!tasksForList(tasks, list, today).some((x) => x.id === t.id)) setList("all");
              setHighlight(t.id);
              setFocusId(t.id);
            }}
          />
        )}
        {tab === "tasks" && !onboarding && view === "list" && viewedProject !== null && (
          <ProjectHeader
            name={viewedProject}
            stats={projectStats.find((p) => p.name === viewedProject) ?? null}
            onAddUnder={(heading) => {
              setAddHeading(heading);
              setAdding(true);
            }}
            onRename={async (to) => {
              try {
                await api.renameProject(viewedProject, to);
                setList(projectList(to));
              } catch (e) {
                setError(String(e));
              }
            }}
          />
        )}
        {tab === "tasks" && !onboarding && view === "list" && adding && list !== "logbook" && (
          <AddTaskForm
            locale={LOCALE}
            defaultDay={list === "today" ? today : null}
            extra={
              viewedProject !== null
                ? { project: viewedProject, heading: addHeading }
                : list === "someday"
                  ? { someday: true, due_date: null }
                  : undefined
            }
            context={viewedProject !== null ? `in ${viewedProject}${addHeading ? ` · ${addHeading}` : ""}` : undefined}
            placeholder="What needs doing? Try “send deck fri 3pm”"
            onAdd={async (task) => {
              try {
                await api.addTask(task);
                show(task.due_date ? `Added for ${relativeLabel(task.due_date, new Date(), LOCALE).toLowerCase()}` : "Task added");
              } catch (e) {
                setError(String(e));
                throw e;
              }
            }}
            onCancel={() => {
              setAdding(false);
              setAddHeading(null);
            }}
          />
        )}
        {tab === "tasks" && !onboarding && view === "list" && list === "logbook" && (
          <Logbook actions={actions} now={now} locale={LOCALE} query={query} onOpenProject={openProject} />
        )}
        {tab === "tasks" && !onboarding && view === "list" && list !== "logbook" && (
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
            focusToday={focusToday}
            today={today}
            projects={projectInfos}
            inProject={viewedProject}
            onOpenProject={openProject}
            selected={selected}
            onSelect={selectTask}
            emptyNote={
              list === "someday" && !query.trim() ? (
                <>
                  <p className="empty-big">Nothing in Someday</p>
                  <p>Park ideas here from a task's date menu — they stay out of Today and the calendar.</p>
                </>
              ) : viewedProject !== null && !query.trim() ? (
                <>
                  <p className="empty-big">No tasks in {viewedProject}</p>
                  <p>Add one above, or move tasks here with the folder button.</p>
                </>
              ) : undefined
            }
          />
        )}
        {tab === "tasks" && !onboarding && view === "list" && list === "all" && listCounts.someday > 0 && !query.trim() && (
          <button type="button" className="someday-link" onClick={() => setList("someday")}>
            {listCounts.someday} in Someday →
          </button>
        )}
        {tab === "connectors" && <ConnectorsTab />}
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
            onTour={() => {
              setTab("tasks");
              setTour(true);
            }}
          />
        )}
      </main>

      {tab === "tasks" && view === "list" && selectedTasks.length > 0 && (
        <BatchBar tasks={selectedTasks} actions={actions} projects={projectInfos} onClear={() => setSelected(new Set())} />
      )}
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
        <span className="local-dot" aria-hidden />
        <span className="foot-text" data-tauri-drag-region>
          On-device · <kbd>{captureLabel}</kbd> capture
          {quickLabel && (
            <>
              {" "}
              · <kbd>{quickLabel}</kbd> type
            </>
          )}
        </span>
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
