import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CaptureCard, type CaptureState } from "./components/CaptureCard";
import { ModelsTab } from "./components/ModelsTab";
import { ConnectorsTab } from "./components/ConnectorsTab";
import { Onboarding } from "./components/Onboarding";
import { processCapture } from "./lib/capture";
import { UpdateBanner } from "./components/UpdateBanner";
import { SettingsTab } from "./components/SettingsTab";
import { type RowCommand, TaskDetail, TaskList } from "./components/TaskList";
import { Sidebar } from "./components/Sidebar";
import { CityCard, CityView } from "./components/City";
import { buildCity } from "./lib/city";
import { CITY, PLAIN, WordsContext } from "./lib/words";
import { WeekGrid, WeekSide, sevenDays } from "./components/WeekGrid";
import { MonthCalendar } from "./components/MonthCalendar";
import { applyLook, lookOf, weekStartOf } from "./lib/look";
import { ProjectColors } from "./lib/colors";
import { Toasts, useToasts } from "./components/Toasts";
import { ClockIcon, GearIcon, PlusIcon, SearchIcon } from "./components/icons";
import { ViewSwitch } from "./components/ViewSwitch";
import { WeekView } from "./components/WeekView";
import { WeekStrip } from "./components/WeekStrip";
import { DayPlan } from "./components/DayPlan";
import { DragGhost } from "./components/DragGhost";
import { useTaskDrag } from "./lib/useTaskDrag";
import { dropPatch } from "./lib/plan";
import {
  api,
  onCalendarChanged,
  onCapture,
  onHighlightTask,
  onOpenTab,
  onPanelCollapsed,
  onPanelFull,
  onShortcutsChanged,
  onTasksChanged,
  onUpdateStatus,
} from "./lib/api";
import { formatShortcut, type ShortcutSettings } from "./lib/shortcuts";
import { addDays, parseISODate, toISODate } from "./lib/dates";
import { groupTasks } from "./lib/grouping";
import { groupByHeading, headingsOf, listTitle, projectList, projectOf, tasksForList, type ListId } from "./lib/lists";
import { CalIcon, CloudIcon, LinesIcon, ListPicker, LogIcon, Pie, StarIcon } from "./components/ListPicker";
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
import type { AppSettings, CalendarEvent, CaptureResult, CityWindow, FloorSummary, NewTask, ProjectSummary, Status, Task, UpdateStatus } from "./lib/types";
import { safeLocale } from "./lib/locale";

const LOCALE = safeLocale();

type Tab = "tasks" | "connectors" | "models" | "settings";
const TABS: { id: Tab; label: string }[] = [
  { id: "tasks", label: "Tasks" },
  { id: "settings", label: "Preferences" },
  { id: "connectors", label: "Connectors" },
  { id: "models", label: "Models" },
];
const isTab = (t: string): t is Tab => TABS.some((x) => x.id === t);

type TodayMode = "list" | "hours";
function saved<T extends string>(key: string, allowed: T[], fallback: T): T {
  try {
    const v = localStorage.getItem(key) as T | null;
    return v && allowed.includes(v) ? v : fallback;
  } catch {
    return fallback;
  }
}
function remember(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Storage unavailable: the choice lasts this session.
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
  ["F", "Today ↔ Anytime"],
  ["C", "Sub-tasks (checklist)"],
  ["P", "Move to a project"],
  ["V", "Today as a list or in hours"],
  ["← →", "Day before / after (Calendar)"],
  ["/ or ⌘F", "Search"],
  ["⌃⌘F", "Full screen ↔ side panel"],
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
  // Full screen: the panel as a big window with a sidebar and a detail pane.
  const [full, setFull] = useState(false);
  const [sideOpen, setSideOpen] = useState(() => saved("pluck.sidebar", ["open", "closed"], "open") === "open");
  useEffect(() => remember("pluck.sidebar", sideOpen ? "open" : "closed"), [sideOpen]);
  // The side panel's window is see-through around its rounded card; full
  // screen paints the whole window.
  useEffect(() => {
    document.documentElement.dataset.full = full ? "1" : "";
  }, [full]);
  useEffect(() => {
    if (full) api.cityWindows().then(setCityWins, () => undefined);
    else setCityOpen(null);
  }, [full]);
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
      return localStorage.getItem("pluck.view") === "week" ? "upcoming" : "today";
    } catch {
      return "today";
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
  // Each project's headings: the floors of its building.
  const [floorList, setFloorList] = useState<FloorSummary[]>([]);
  // Tasks selected for batch actions, and where a Shift-click range starts.
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const anchor = useRef<number | null>(null);
  // Today as a list, or in hour blocks. Remembered per Mac.
  const [todayMode, setTodayMode] = useState<TodayMode>(() => saved("pluck.todayMode", ["list", "hours"], "list"));
  useEffect(() => remember("pluck.todayMode", todayMode), [todayMode]);
  const upcoming = list === "upcoming";
  // Full screen always shows Today with its hours beside the list.
  const todayHours = list === "today" && (full || todayMode === "hours");
  // The task list shows except in the week — and in full screen, Today's
  // hours sit beside it rather than replacing it.
  const showList = !upcoming && (!todayHours || full);
  // The search field shows on demand (/, ⌘F or the magnifier).
  const [searchOpen, setSearchOpen] = useState(false);
  // The task opened as a card.
  const [openId, setOpenId] = useState<number | null>(null);
  const [planDay, setPlanDay] = useState(() => toISODate(new Date()));
  // Full screen's right side: the day picked in the month calendar.
  const [sideDay, setSideDay] = useState(() => toISODate(new Date()));
  // The user's own touches: clock, accent, first day of the week, the city.
  const look = lookOf(settings);
  applyLook(look);
  const weekStart = useMemo(() => weekStartOf(look, LOCALE), [look.week_start]); // eslint-disable-line react-hooks/exhaustive-deps
  // Open on the list picked in Preferences (once, when settings first load).
  const startApplied = useRef(false);
  useEffect(() => {
    if (!settings || startApplied.current) return;
    startApplied.current = true;
    const s = lookOf(settings).start_list;
    if (s !== "last") setList(s);
  }, [settings]);
  const captureSeq = useRef(0);
  const statusRef = useRef<Status | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const today = toISODate(now);
  const { toasts, show, dismiss, undoLast } = useToasts();
  // The add-task form at the top of the list.
  const [adding, setAdding] = useState(false);
  // The heading new tasks go under, when adding from a project's heading.
  const [addHeading, setAddHeading] = useState<string | null>(null);
  // Full screen: one floor of a building on a page of its own (floor null: the lobby).
  const [floorView, setFloorView] = useState<{ project: string; floor: string | null } | null>(null);
  const actions = useMemo(() => taskActions(show, LOCALE), [show]);
  const fullRef = useRef(false);
  fullRef.current = full;
  const toggleFull = useCallback(() => {
    const next = !fullRef.current;
    setFull(next);
    api.setPanelFull(next).catch((e) => {
      setFull(!next);
      setError(String(e));
    });
  }, []);
  const toggleFullRef = useRef(toggleFull);
  toggleFullRef.current = toggleFull;
  // The city (full screen): finished tasks, and whether it's open.
  const [cityWins, setCityWins] = useState<CityWindow[]>([]);
  const [cityOpen, setCityOpen] = useState<null | "view" | "share">(null);

  const refresh = useCallback(async () => {
    try {
      api.listProjects().then(setProjectStats, () => undefined);
      api.listFloors().then(setFloorList, () => undefined);
      if (fullRef.current) api.cityWindows().then(setCityWins, () => undefined);
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
    api
      .panelFull()
      .then((f) => setFull(!!f))
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
        setList("all");
        setQuery("");
        setHighlight(id);
        setFocusId(id);
      }),
      onPanelCollapsed(setCollapsed),
      onPanelFull(setFull),
      onUpdateStatus(setUpdate),
    ];
    return () => {
      subs.forEach((p) => void p.then((unlisten) => unlisten()));
    };
  }, [handleCapture, refresh]);

  const nowTime = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
  // Full screen, a project: every task in it, done ones too (they stay on their floor, crossed out).
  const [projectAll, setProjectAll] = useState<Task[]>([]);
  const viewing = projectOf(list);
  useEffect(() => {
    if (!full || viewing === null) {
      setProjectAll([]);
      return;
    }
    let live = true;
    api
      .projectTasks(viewing)
      .then((t) => live && setProjectAll(t))
      .catch(() => live && setProjectAll([]));
    return () => {
      live = false;
    };
  }, [full, viewing, tasks]);
  const visible = useMemo(() => {
    let base = tasksForList(tasks, list, today, nowTime);
    if (viewing !== null && projectAll.length) {
      const have = new Set(base.map((t) => t.id));
      base = [...base, ...projectAll.filter((t) => t.done && !have.has(t.id) && t.project === viewing)];
    }
    return base.filter((t) => !query.trim() || matchesQuery(t, query));
  }, [tasks, query, list, today, nowTime, viewing, projectAll]);
  const firing = useMemo(() => dueNow(tasks, now), [tasks, now]);
  const viewedProject = projectOf(list);
  const floorOpen = full && floorView && floorView.project === viewedProject ? floorView : null;
  useEffect(() => {
    if (floorView && projectOf(list) !== floorView.project) setFloorView(null);
  }, [list, floorView]);
  const groups = useMemo(() => {
    if (list === "logbook") return [];
    if (viewedProject === null) return groupTasks(visible, now, LOCALE);
    const all = groupByHeading(visible, full);
    // A floor's page: just that floor's tasks.
    return floorOpen ? all.filter((g) => g.key === `h:${floorOpen.floor ?? ""}`) : all;
  }, [visible, now, list, viewedProject, floorOpen, full]);
  const listCounts = useMemo(
    () => ({
      all: tasksForList(tasks, "all", today).filter((t) => !t.done).length,
      today: tasksForList(tasks, "today", today).filter((t) => !t.done).length,
      someday: tasks.filter((t) => !t.done && t.someday).length,
      overdue: tasksForList(tasks, "overdue", today, nowTime).length,
    }),
    [tasks, today, nowTime],
  );
  const projectInfos: ProjectInfo[] = useMemo(() => {
    const names = new Set([...projectStats.map((p) => p.name), ...tasks.flatMap((t) => (t.project ? [t.project] : []))]);
    return [...names].sort((a, b) => a.localeCompare(b)).map((name) => ({ name, headings: headingsOf(tasks, name) }));
  }, [projectStats, tasks]);
  // Today's calendar events, for Today in hours.
  const [todayEvents, setTodayEvents] = useState<CalendarEvent[]>([]);
  const [eventsKey, setEventsKey] = useState(0);
  useEffect(() => {
    let live = true;
    api
      .calendarEvents(today, today)
      .then((e) => live && setTodayEvents(e))
      .catch(() => live && setTodayEvents([]));
    return () => {
      live = false;
    };
  }, [today, eventsKey]);
  useEffect(() => {
    const sub = onCalendarChanged(() => setEventsKey((k) => k + 1));
    return () => void sub.then((u) => u());
  }, []);
  async function addFromPlan(task: NewTask) {
    try {
      await api.addTask(task);
      show(
        task.due_time
          ? `Added at ${timeLabel(task.due_time, LOCALE)}`
          : task.due_date
            ? `Added for ${relativeLabel(task.due_date, new Date(), LOCALE).toLowerCase()}`
            : "Task added",
      );
    } catch (e) {
      setError(String(e));
      throw e;
    }
  }
  /** From an hour block: show the task in a list, opened. */
  function showInList(t: Task) {
    setAdding(false);
    setQuery("");
    setTodayMode("list");
    setList(t.due_date && t.due_date <= today ? "today" : "all");
    setHighlight(t.id);
    setFocusId(t.id);
    window.setTimeout(() => setOpenId(t.id), 0);
  }
  const openProject = (name: string) => {
    setFloorView(null);
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
  useEffect(() => {
    setSelected(new Set());
    setOpenId(null);
  }, [list, tab, todayMode]);
  // Drag a task onto a day of the week strip (or an hour, in Today's hours).
  const drag = useTaskDrag((task, to) => {
    const patch = dropPatch(task, to);
    if (patch) void actions.reschedule(task, patch);
  });
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
  const projectColors = useMemo(
    () => Object.fromEntries(projectStats.flatMap((p) => (p.color ? [[p.name, p.color] as [string, string]] : []))),
    [projectStats],
  );
  const city = useMemo(() => buildCity(cityWins, tasks, projectStats, floorList, today), [cityWins, tasks, projectStats, floorList, today]);
  // Full screen's add form picks the building and floor.
  const places = useMemo(
    () => city.buildings.filter((b) => b.project).map((b) => ({ name: b.project!, floors: b.floors.filter((f) => f.name).map((f) => f.name!) })),
    [city],
  );

  // Keyboard: Esc, undo, search and list navigation.
  const keyState = useRef({ flat, focusId, capture, tab, query, showKeys, upcoming, selectedTasks, openId, searchOpen, full, cityOpen });
  keyState.current = { flat, focusId, capture, tab, query, showKeys, upcoming, selectedTasks, openId, searchOpen, full, cityOpen };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const s = keyState.current;
      // The city has its own keys.
      if (s.cityOpen) return;
      const mod = e.metaKey || e.ctrlKey;
      if (e.key === "Escape" && !e.defaultPrevented) {
        if (s.showKeys) setShowKeys(false);
        else if (s.openId !== null) setOpenId(null);
        else if (s.selectedTasks.length) setSelected(new Set());
        else if (s.capture) setCapture(null);
        else if (s.searchOpen && document.activeElement === searchRef.current) {
          setQuery("");
          setSearchOpen(false);
        } else if (s.tab !== "tasks") setTab("tasks");
        // Full screen is a window to stay in; Esc only hides the side panel.
        else if (!s.full) void api.hidePanel();
        return;
      }
      if (e.ctrlKey && e.metaKey && e.key.toLowerCase() === "f") {
        e.preventDefault();
        toggleFullRef.current();
        return;
      }
      if (s.full && mod && e.key === ",") {
        e.preventDefault();
        setTab("settings");
        return;
      }
      if (s.full && mod && e.key === "\\") {
        e.preventDefault();
        setSideOpen((o) => !o);
        return;
      }
      if (mod && e.key.toLowerCase() === "z" && !e.shiftKey && !typingIn(e.target)) {
        if (undoLast()) e.preventDefault();
        return;
      }
      if (s.tab !== "tasks") return;
      if ((mod && (e.key.toLowerCase() === "f" || e.key.toLowerCase() === "k")) || (e.key === "/" && !typingIn(e.target))) {
        e.preventDefault();
        setSearchOpen(true);
        window.setTimeout(() => {
          searchRef.current?.focus();
          searchRef.current?.select();
        }, 0);
        return;
      }
      if (s.upcoming && !typingIn(e.target) && !mod && !e.altKey && !s.capture) {
        // The week has no list to move through; its own few keys.
        const k = e.key.toLowerCase();
        let used = true;
        if (k === "a") setAdding(true);
        else if (k === "f") setList("today");
        else if (e.key === "?") setShowKeys((v) => !v);
        else if (k === "t") setPlanDay(toISODate(new Date()));
        else if (e.key === "ArrowLeft") setPlanDay((d) => toISODate(addDays(parseISODate(d), s.full ? -7 : -1)));
        else if (e.key === "ArrowRight") setPlanDay((d) => toISODate(addDays(parseISODate(d), s.full ? 7 : 1)));
        else used = false;
        if (used) e.preventDefault();
        return;
      }
      // ⌘A selects every open task shown.
      if (mod && e.key.toLowerCase() === "a" && !typingIn(e.target) && !s.upcoming && !s.capture) {
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
        // In full screen the detail pane follows along.
        if (s.full && s.openId !== null) setOpenId(s.flat[next].id);
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
      else if (lower === "v") setTodayMode((m) => (m === "list" ? "hours" : "list"));
      else if (!current) handled = false;
      else if (key === " " || lower === "x") void actions.setDone(current, !current.done);
      else if (key === "Enter" || lower === "e") setCommand({ id: current.id, kind: "edit", n });
      else if (key === "ArrowRight") setOpenId(current.id);
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

  // Settings changes one after another, each on top of the last (so two quick
  // changes — the city's name and the mayor's — don't overwrite each other).
  const settingsChain = useRef<Promise<void>>(Promise.resolve());
  function patchSettings(patch: Partial<AppSettings>) {
    settingsChain.current = settingsChain.current.then(async () => {
      try {
        const cur = await api.getSettings();
        setSettings(await api.setSettings({ ...cur, ...patch }));
      } catch (e) {
        setError(String(e));
      }
    });
    return settingsChain.current;
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

  // The side panel's window buttons, top left as on every Mac window: close
  // (hide), minimize (to the slim bar) and zoom (full screen).
  const controls = (
    <div className="traffic" data-tauri-drag-region>
      <button type="button" className="tl close" onClick={() => void api.hidePanel()} aria-label="Close" title="Close (Esc)">
        <svg viewBox="0 0 12 12" aria-hidden>
          <path d="M3.5 3.5l5 5M8.5 3.5l-5 5" />
        </svg>
      </button>
      <button
        type="button"
        className="tl min"
        onClick={() => minimize(!collapsed)}
        aria-label={collapsed ? "Expand panel" : "Minimize panel"}
        title={collapsed ? "Expand" : "Minimize to a slim bar"}
      >
        <svg viewBox="0 0 12 12" aria-hidden>
          <path d="M3 6h6" />
        </svg>
      </button>
      <button type="button" className="tl zoom" onClick={toggleFull} aria-label="Open full screen" title="Full screen (⌃⌘F)">
        <svg viewBox="0 0 12 12" aria-hidden>
          <path d="M3.2 6.6V8.8h2.2M8.8 5.4V3.2H6.6" />
        </svg>
      </button>
    </div>
  );

  if (collapsed && !full) {
    return (
      <div className="panel collapsed">
        <header className="mini" data-tauri-drag-region onDoubleClick={() => minimize(false)}>
          {controls}
          <span className="mini-title" data-tauri-drag-region>
            Todo City
          </span>
          <span className="mini-meta" data-tauri-drag-region>
            {open} open{dueToday ? ` · ${dueToday} due` : ""}
          </span>
        </header>
      </div>
    );
  }

  const stats = viewedProject !== null ? projectStats.find((p) => p.name === viewedProject) : undefined;
  // Full screen: plain words, with floors for a project's sections.
  const w = full ? CITY : PLAIN;
  const floorShown = floorOpen ? city.buildings.find((b) => b.project === floorOpen.project)?.floors.find((f) => f.name === floorOpen.floor) : undefined;
  const floorTitle = floorShown?.label ?? (floorOpen?.floor ? floorOpen.floor : CITY.looseHeading);
  const floorSub = floorOpen
    ? `${CITY.progress(floorShown?.rooms.filter((r) => !r.lit).length ?? 0, floorShown?.rooms.filter((r) => r.lit).length ?? 0)}`
    : "";
  const weekDays = sevenDays(planDay);
  const rangeText = (() => {
    const a = parseISODate(weekDays[0]);
    const b = parseISODate(weekDays[6]);
    try {
      return new Intl.DateTimeFormat(LOCALE, { month: "short", day: "numeric" }).formatRange(a, b);
    } catch {
      return `${a.toLocaleDateString(LOCALE)} – ${b.toLocaleDateString(LOCALE)}`;
    }
  })();
  const subText =
    tab !== "tasks"
      ? tab === "connectors"
        ? "Work with apps on this Mac"
        : tab === "models"
          ? status?.active_model
            ? `Using ${status.active_model}`
            : "No model yet"
          : `Todo City ${status?.version ?? ""}`
      : list === "today"
        ? `${now.toLocaleDateString(LOCALE, { weekday: "long", month: "short", day: "numeric" })} · ${w.toDo(listCounts.today)}`
        : list === "upcoming"
          ? full
            ? rangeText
            : "Your week, hour by hour"
          : list === "all"
            ? w.open(listCounts.all)
            : list === "overdue"
              ? listCounts.overdue
                ? `${listCounts.overdue} past their day, time or deadline`
                : "All caught up"
            : list === "someday"
              ? "Ideas and paused repeats, out of the way"
              : list === "logbook"
                ? "Everything you've finished"
                : stats
                  ? w.progress(stats.open, stats.done)
                  : "";

  const banners = (
    <>
      {tab !== "settings" && <UpdateBanner update={update} onError={setError} />}
      {status && !status.accessibility && !capture && !onboarding && (
        <Banner tone="warn" action={{ label: "Grant access", run: grantAccess }}>
          Todo City needs Accessibility permission to read selected text.
        </Banner>
      )}
      {tab === "tasks" && status?.engine === "bundled" && !status.active_model && !onboarding && (
        <Banner tone="warn" action={{ label: "Get a model", run: () => setTab("models") }}>
          Download a model so Todo City can read your selections.
        </Banner>
      )}
      {error && (
        <Banner tone="error" action={{ label: "Dismiss", run: () => setError(null) }}>
          {error}
        </Banner>
      )}
    </>
  );

  const tourEl = tab === "tasks" && onboarding && (
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
  );

  const captureEl = tab === "tasks" && capture && (
    <CaptureCard state={capture} now={now} onSave={save} onCancel={() => setCapture(null)} onGrantAccess={grantAccess} />
  );

  const searchEl = tab === "tasks" && !onboarding && searchOpen && (
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
        {query && (
          <button type="button" className="search-clear" aria-label="Clear search" onClick={() => setQuery("")}>
            ×
          </button>
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
  );

  const tasksShown = tab === "tasks" && !onboarding;
  const listEl = tasksShown && (
    <>
      {showList && viewedProject !== null && !floorOpen && (
        <ProjectHeader
          name={viewedProject}
          stats={projectStats.find((p) => p.name === viewedProject) ?? null}
          onAddUnder={(heading) => {
            // A new heading (floor) stays even before a task is on it.
            if (heading) void api.addFloor(viewedProject, heading).then(() => refresh(), () => undefined);
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
      {showList && adding && list !== "logbook" && (
        <AddTaskForm
          places={full ? places : undefined}
          locale={LOCALE}
          defaultDay={list === "today" ? today : null}
          projects={projectInfos.map((p) => p.name)}
          extra={
            viewedProject !== null
              ? { project: viewedProject, heading: floorOpen ? floorOpen.floor : addHeading }
              : list === "someday"
                ? { someday: true, due_date: null }
                : undefined
          }
          context={
            viewedProject !== null
              ? `${w.inProject(viewedProject)}${(floorOpen ? floorOpen.floor : addHeading) ? ` · ${floorOpen ? floorOpen.floor : addHeading}` : ""}`
              : undefined
          }
          placeholder="What needs doing? Try “send deck fri 3pm @Work”"
          onAdd={async (task) => {
            try {
              // No day and no project: it waits in Someday until you plan it.
              const loose = !task.due_date && !task.project && !task.someday;
              await api.addTask(loose ? { ...task, someday: true } : task);
              show(
                task.due_date
                  ? `Added for ${relativeLabel(task.due_date, new Date(), LOCALE).toLowerCase()}`
                  : loose
                    ? "Added to Someday — give it a day or a project to plan it"
                    : "Task added",
              );
              // Added: the form closes; the add button opens it again.
              setAdding(false);
              setAddHeading(null);
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
      {list === "logbook" && <Logbook actions={actions} now={now} locale={LOCALE} query={query} onOpenProject={openProject} />}
      {showList && list !== "logbook" && (
        <TaskList
          groups={viewedProject !== null ? groups.map((g) => (g.key === "h:" ? { ...g, label: w.looseHeading } : g)) : groups}
          plain={!!floorOpen}
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
          drag={drag}
          openId={openId}
          onOpenTask={setOpenId}
          detail={false}
          rich={full}
          details={look.details}
          emptyNote={
            list === "overdue" && !query.trim() ? (
              <>
                <p className="empty-big">Nothing overdue</p>
                <p>Tasks whose day, time or deadline has passed gather here, so nothing slips by.</p>
              </>
            ) : list === "someday" && !query.trim() ? (
              <>
                <p className="empty-big">Nothing in Someday</p>
                <p>Park ideas here from a task's date menu — they stay out of Today and the calendar.</p>
              </>
            ) : floorOpen && !query.trim() ? (
              <>
                <p className="empty-big">{floorOpen.floor ? "No tasks on this floor yet" : "Nothing on the ground floor"}</p>
                <p>
                  <button type="button" className="primary floor-add" onClick={() => setAdding(true)}>
                    <PlusIcon /> {w.addButton}
                  </button>
                </p>
              </>
            ) : viewedProject !== null && !query.trim() ? (
              <>
                <p className="empty-big">{w.emptyProject(viewedProject)}</p>
                <p>
                  Add one with {full ? w.addButton : "+"}, or type “@{viewedProject}” in a new {w.task}.
                </p>
              </>
            ) : undefined
          }
        />
      )}
      {list === "all" && listCounts.someday > 0 && !query.trim() && (
        <button type="button" className="someday-link" onClick={() => setList("someday")}>
          {listCounts.someday} in Someday →
        </button>
      )}
    </>
  );

  const settingsEl = (
    <>
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
    </>
  );

  const keysSheet = showKeys && (
    <div className="keys-sheet" role="dialog" aria-label="Keyboard shortcuts" onClick={() => setShowKeys(false)}>
      <div className="keys-card" onClick={(e) => e.stopPropagation()}>
        <h2>Keyboard</h2>
        <dl>
          {KEYS.filter(([k]) => !full || k !== "V").map(([k, v]) => (
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
  );

  const captureHint =
    settings?.double_copy !== false ? (
      <>
        <kbd>⌘C</kbd> twice
      </>
    ) : (
      <kbd>{captureLabel}</kbd>
    );

  if (full) {
    const openTask = openId !== null ? (tasks.find((t) => t.id === openId) ?? null) : null;
    // The right side follows the page: a project's tasks, a floor's, or all of them.
    const sideTasks =
      viewedProject === null
        ? tasks
        : tasks.filter((t) => t.project === viewedProject && (!floorOpen || (t.heading ?? null) === floorOpen.floor));
    const ids = flat.map((t) => t.id);
    const stepTask = (d: -1 | 1) => {
      const i = ids.indexOf(openId ?? -1);
      const next = ids[i + d];
      if (next !== undefined) {
        setOpenId(next);
        setFocusId(next);
      }
    };
    const crumbs = openTask
      ? [openTask.project ?? listTitle(list), ...(openTask.project && openTask.heading ? [openTask.heading] : [])]
      : [];
    // A task opens in place in the list; one that isn't in it (picked from the
    // calendar or the hours) opens in the detail pane.
    const inList = openTask ? flat.some((t) => t.id === openTask.id) && !upcoming : false;
    const sidePane = !tasksShown ? null : openTask && !inList ? (
      <TaskDetail
        task={openTask}
        actions={actions}
        now={now}
        locale={LOCALE}
        projects={projectInfos}
        command={command}
        crumbs={crumbs}
        onClose={() => setOpenId(null)}
        onStep={ids.includes(openTask.id) ? stepTask : undefined}
      />
    ) : upcoming ? (
      <WeekSide
        tasks={tasks}
        days={weekDays}
        today={today}
        now={now}
        locale={LOCALE}
        drag={drag}
        onOpen={(t) => setOpenId(t.id)}
        month={
          <MonthCalendar tasks={tasks} today={today} selected={planDay} locale={LOCALE} weekStart={weekStart} drag={drag} onSelect={setPlanDay} />
        }
      />
    ) : list !== "logbook" ? (
      // Every list: the month at a glance, and the picked day's hours below
      // it — in a project or on a floor, only that project's or floor's tasks.
      <aside className="side-pane plan-pane month-pane" aria-label="Calendar">
        <MonthCalendar
          tasks={sideTasks}
          today={today}
          selected={sideDay}
          locale={LOCALE}
          weekStart={weekStart}
          drag={drag}
          onSelect={setSideDay}
          scope={
            viewedProject !== null
              ? { label: floorOpen ? `${viewedProject} · ${floorTitle}` : viewedProject, color: projectColors[viewedProject] }
              : null
          }
        />
        <div className="sp-head">
          <span className="sp-title">
            {sideDay === today ? "Today" : parseISODate(sideDay).toLocaleDateString(LOCALE, { weekday: "long", month: "short", day: "numeric" })}
          </span>
          <span className="sp-count">Drag a task onto an hour</span>
        </div>
        <DayPlan
          tasks={sideTasks}
          day={sideDay}
          today={today}
          now={now}
          locale={LOCALE}
          events={sideDay === today && viewedProject === null ? todayEvents : []}
          actions={actions}
          drag={drag}
          onAdd={addFromPlan}
          onOpen={(t) => setOpenId(t.id)}
        />
      </aside>
    ) : null;

    // The window's own buttons, top left as on every Mac window: close
    // (hide Todo City), minimize to the Dock, and back to the side panel.
    const lights = (
      <div className="traffic" data-tauri-drag-region>
        <button type="button" className="tl close" onClick={() => void api.hidePanel()} aria-label="Close" title="Close (hide Todo City)">
          <svg viewBox="0 0 12 12" aria-hidden>
            <path d="M3.5 3.5l5 5M8.5 3.5l-5 5" />
          </svg>
        </button>
        <button type="button" className="tl min" onClick={() => void api.minimizePanel().catch((e) => setError(String(e)))} aria-label="Minimize" title="Minimize to the Dock">
          <svg viewBox="0 0 12 12" aria-hidden>
            <path d="M3 6h6" />
          </svg>
        </button>
        <button type="button" className="tl zoom" onClick={toggleFull} aria-label="Back to the side panel" title="Back to the side panel (⌃⌘F)">
          <svg viewBox="0 0 12 12" aria-hidden>
            <path d="M3.2 6.6V8.8h2.2M8.8 5.4V3.2H6.6" />
          </svg>
        </button>
      </div>
    );
    return (
      <ProjectColors.Provider value={projectColors}>
      <WordsContext.Provider value={CITY}>
      <div className={["app-full", drag.drag ? "dragging" : "", look.compact ? "compact" : ""].filter(Boolean).join(" ")}>
        {sideOpen && (
          <Sidebar
            list={list}
            inSettings={tab !== "tasks"}
            onList={(l) => {
              setTab("tasks");
              setList(l);
              setFloorView(null);
              setAdding(false);
              setQuery("");
              setSearchOpen(false);
            }}
            counts={listCounts}
            projects={projectStats}
            tags={tags}
            activeTags={query.toLowerCase().split(/\s+/).filter(Boolean)}
            onTag={(t) => {
              setSearchOpen(true);
              toggleTag(t);
            }}
            onSearch={() => {
              setTab("tasks");
              setSearchOpen(true);
              window.setTimeout(() => searchRef.current?.focus(), 0);
            }}
            onSettings={() => setTab(tab === "tasks" ? "settings" : "tasks")}
            onKeys={() => setShowKeys(true)}
            onCity={() => setCityOpen("view")}
            cityName={settings?.city_name ?? null}
            mayor={settings?.mayor_name ?? null}
            lit={city.total}
            buildings={city.buildings.filter((b) => b.project)}
            floorOn={tab === "tasks" ? floorOpen : null}
            onFloor={(project, floor) => {
              // The floor's own page: its rooms, and adding a room adds it there.
              setTab("tasks");
              setQuery("");
              setAdding(false);
              setOpenId(null);
              setList(projectList(project));
              setFloorView({ project, floor });
            }}
            onNewBuilding={(name) =>
              void api
                .createProject(name)
                .then((made) => {
                  void refresh();
                  if (made) {
                    setTab("tasks");
                    setList(projectList(made));
                    show(`Started ${made} — a new building in your city`);
                  }
                })
                .catch((e) => setError(String(e)))
            }
            onNewFloor={(project, name) =>
              void api
                .addFloor(project, name)
                .then(() => refresh())
                .catch((e) => setError(String(e)))
            }
            onRenameBuilding={(from, to) =>
              void api
                .renameProject(from, to)
                .then(() => {
                  void refresh();
                  if (projectOf(list) === from) setList(projectList(to));
                  show(`Renamed ${from} to ${to}`);
                })
                .catch((e) => setError(String(e)))
            }
            onDeleteBuilding={(name) =>
              void api
                .deleteProject(name)
                .then((gone) => {
                  void refresh();
                  if (!gone) {
                    show(`${name} still has tasks — delete or move them first`);
                    return;
                  }
                  if (projectOf(list) === name) setList("today");
                  show(`Took down ${name}`);
                })
                .catch((e) => setError(String(e)))
            }
            onRenameFloor={(project, from, to) =>
              void api
                .renameFloor(project, from, to)
                .then(() => {
                  void refresh();
                  setFloorView((f) => (f && f.project === project && f.floor === from ? { project, floor: to } : f));
                  show(`Renamed the floor to ${to}`);
                })
                .catch((e) => setError(String(e)))
            }
            onColor={(project, color) =>
              void api
                .setProjectColor(project, color)
                .then(() => refresh())
                .catch((e) => setError(String(e)))
            }
            onDeleteFloor={(project, name) =>
              void api
                .deleteFloor(project, name)
                .then((gone) => {
                  void refresh();
                  if (!gone) {
                    show(`${name} still has tasks — delete or move them first`);
                    return;
                  }
                  setFloorView((f) => (f && f.project === project && f.floor === name ? null : f));
                  show(`Removed the ${name} floor`);
                })
                .catch((e) => setError(String(e)))
            }
            updateReady={update.state === "ready"}
            model={status?.active_model ?? null}
            captureHint={<>{captureHint} to capture</>}
            lights={lights}
          />
        )}
        <div className="full-main">
          <header className="full-head" data-tauri-drag-region>
            {!sideOpen && lights}
            <button
              type="button"
              className={sideOpen ? "icon" : "icon on"}
              onClick={() => setSideOpen((o) => !o)}
              aria-label={sideOpen ? "Hide sidebar" : "Show sidebar"}
              title={`${sideOpen ? "Hide" : "Show"} sidebar (⌘\\)`}
            >
              <SidebarIcon />
            </button>
            <span className="fh-icon" aria-hidden>
              {tab !== "tasks" ? <GearIcon /> : <ListIcon list={list} stats={stats} />}
            </span>
            {/* Where you are, as a breadcrumb: Project › Floor. Earlier steps are links. */}
            <nav className="fh-crumbs" aria-label="You are here" data-tauri-drag-region>
              {tab === "tasks" && floorOpen && (
                <>
                  <button type="button" className="fh-crumb" onClick={() => setFloorView(null)} title={`All of ${floorOpen.project}`}>
                    {floorOpen.project}
                  </button>
                  <span className="fh-crumb-sep" aria-hidden>
                    ›
                  </span>
                </>
              )}
              <h1 className="fh-title" data-tauri-drag-region>
                {tab !== "tasks" ? "Settings" : floorOpen ? floorTitle : listTitle(list)}
              </h1>
            </nav>
            <span className="fh-sub" data-tauri-drag-region>
              {tab === "tasks" && floorOpen ? floorSub : subText}
            </span>
            {tab === "tasks" && upcoming && (
              <div className="fh-week">
                <button type="button" className="fh-btn" onClick={() => setPlanDay((d) => toISODate(addDays(parseISODate(d), -7)))} aria-label="Previous week" title="Previous week (←)">
                  ‹
                </button>
                <button type="button" className="fh-btn" onClick={() => setPlanDay(today)} title="From today (T)">
                  Today
                </button>
                <button type="button" className="fh-btn" onClick={() => setPlanDay((d) => toISODate(addDays(parseISODate(d), 7)))} aria-label="Next week" title="Next week (→)">
                  ›
                </button>
              </div>
            )}
            <span className="topbar-gap" data-tauri-drag-region />
            {tasksShown && (
              <button
                type="button"
                className={searchOpen ? "icon on" : "icon"}
                onClick={() => {
                  if (searchOpen) {
                    setSearchOpen(false);
                    setQuery("");
                  } else {
                    setSearchOpen(true);
                    window.setTimeout(() => searchRef.current?.focus(), 0);
                  }
                }}
                aria-label="Search"
                aria-expanded={searchOpen}
                title="Search (/)"
              >
                <SearchIcon />
              </button>
            )}
            {tasksShown && list !== "logbook" && (
              <button type="button" className="primary fh-new" onClick={() => setAdding(true)} title="New task (A)">
                <PlusIcon /> {w.addButton}
              </button>
            )}
          </header>

          {banners}
          {tourEl && <div className="full-tour">{tourEl}</div>}
          {captureEl && <div className="full-capture">{captureEl}</div>}
          {searchEl && <div className="full-search">{searchEl}</div>}

          {tab === "tasks" ? (
            <div className={sidePane ? "full-body with-side" : "full-body"}>
              {upcoming && tasksShown ? (
                <main className="full-content week">
                  {adding && (
                    <AddTaskForm
                      places={places}
                      locale={LOCALE}
                      defaultDay={planDay}
                      projects={projectInfos.map((p) => p.name)}
                      placeholder="What needs doing? Try “call Sam fri 3pm”"
                      onAdd={async (t) => {
                        await addFromPlan(t);
                        setAdding(false);
                      }}
                      onCancel={() => setAdding(false)}
                    />
                  )}
                  <WeekGrid
                    tasks={tasks}
                    day={planDay}
                    today={today}
                    now={now}
                    locale={LOCALE}
                    actions={actions}
                    drag={drag}
                    onAdd={addFromPlan}
                    onOpen={(t) => setOpenId(t.id)}
                    openId={openId}
                  />
                </main>
              ) : (
                <main className="full-content" data-autoscroll>
                  <div className="full-list">{listEl}</div>
                </main>
              )}
              {sidePane}
            </div>
          ) : (
            <div className="full-body settings">
              <nav className="fs-nav" role="tablist" aria-label="Settings">
                {TABS.filter((t) => t.id !== "tasks").map((t) => (
                  <button
                    key={t.id}
                    role="tab"
                    aria-selected={tab === t.id}
                    className={tab === t.id ? "fs-tab on" : "fs-tab"}
                    onClick={() => setTab(t.id)}
                  >
                    {t.label}
                    {t.id === "settings" && update.state === "ready" && <span className="tab-dot" aria-label="Update ready" />}
                  </button>
                ))}
              </nav>
              <main className="fs-content">
                <div className="fs-inner">{settingsEl}</div>
              </main>
            </div>
          )}
        </div>

        {tasksShown && !upcoming && selectedTasks.length > 0 && (
          <BatchBar tasks={selectedTasks} actions={actions} projects={projectInfos} onClear={() => setSelected(new Set())} />
        )}
        {tasksShown && !cityOpen && settings?.city_corner !== false && (
          <div className="city-corner">
            <CityCard
              city={city}
              name={settings?.city_name ?? null}
              now={now}
              onOpen={() => setCityOpen("view")}
              onShare={() => setCityOpen("share")}
              onHide={() => {
                void patchSettings({ city_corner: false });
                show("Your city is hidden. Open it from the sidebar, or bring it back in Preferences.");
              }}
            />
          </div>
        )}
        {cityOpen && (
          <CityView
            city={city}
            name={settings?.city_name ?? null}
            now={now}
            locale={LOCALE}
            startSharing={cityOpen === "share"}
            mayor={settings?.mayor_name ?? null}
            onName={(n) => void patchSettings({ city_name: n })}
            onMayor={(m) => void patchSettings({ mayor_name: m || null })}
            onOpenProject={(project) => {
              setCityOpen(null);
              setTab("tasks");
              setQuery("");
              setSearchOpen(false);
              setList(project ? projectList(project) : "all");
            }}
            onOpenSomeday={() => {
              setCityOpen(null);
              setTab("tasks");
              setQuery("");
              setSearchOpen(false);
              setList("someday");
            }}
            onClose={() => setCityOpen(null)}
            onError={actions.fail}
            onSaved={() => show("Saved a picture of your city to Downloads")}
          />
        )}
        <Toasts toasts={toasts} onDismiss={dismiss} />
        {drag.drag && <DragGhost drag={drag.drag} now={now} locale={LOCALE} />}
        {keysSheet}
      </div>
      </WordsContext.Provider>
      </ProjectColors.Provider>
    );
  }

  return (
    <ProjectColors.Provider value={projectColors}>
    <div className={drag.drag ? "panel dragging" : "panel"}>
      <header className="topbar" data-tauri-drag-region>
        {controls}
        {tab === "tasks" ? (
          <ListPicker
            value={list}
            onChange={(l) => {
              setList(l);
              setAdding(false);
              setQuery("");
              setSearchOpen(false);
            }}
            counts={listCounts}
            projects={projectStats}
            tags={tags}
            onTag={(t) => {
              setSearchOpen(true);
              setQuery(t);
            }}
          />
        ) : (
          <button type="button" className="back-btn" onClick={() => setTab("tasks")} title="Back to tasks (Esc)">
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
              <path d="M10 3.5 5.5 8l4.5 4.5" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            Settings
          </button>
        )}
        <span className="topbar-gap" data-tauri-drag-region />
        {tab === "tasks" && !onboarding && (
          <>
            <button
              type="button"
              className={adding ? "icon accent on" : "icon accent"}
              onClick={() => setAdding((a) => !a)}
              aria-label="Add a task"
              aria-expanded={adding}
              title="Add a task (A)"
            >
              <PlusIcon />
            </button>
            <button
              type="button"
              className={searchOpen ? "icon on" : "icon"}
              onClick={() => {
                if (searchOpen) {
                  setSearchOpen(false);
                  setQuery("");
                } else {
                  setSearchOpen(true);
                  window.setTimeout(() => searchRef.current?.focus(), 0);
                }
              }}
              aria-label="Search"
              aria-expanded={searchOpen}
              title="Search (/)"
            >
              <SearchIcon />
            </button>
          </>
        )}
        <button
          type="button"
          className={tab !== "tasks" ? "icon on" : "icon"}
          onClick={() => setTab(tab === "tasks" ? "settings" : "tasks")}
          aria-label="Settings"
          title="Settings, models and connectors"
        >
          <GearIcon />
          {update.state === "ready" && <span className="icon-dot" aria-label="Update ready" />}
        </button>
      </header>

      {tab === "tasks" ? (
        <div className="subline" data-tauri-drag-region>
          <p className="sub" data-tauri-drag-region>
            {subText}
          </p>
          {list === "today" && !onboarding && (
            <ViewSwitch
              value={todayMode}
              options={[
                ["list", "List"],
                ["hours", "Hours"],
              ]}
              onChange={setTodayMode}
              label="Show today as (V)"
            />
          )}
        </div>
      ) : (
        <nav className="tabs" role="tablist" aria-label="Settings">
          {TABS.filter((t) => t.id !== "tasks").map((t) => (
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
      )}

      {tab === "tasks" && list === "today" && !onboarding && (
        <WeekStrip
          tasks={tasks}
          now={now}
          locale={LOCALE}
          drag={drag.drag}
          onPick={(iso) => {
            setPlanDay(iso);
            setList("upcoming");
          }}
        />
      )}

      {banners}
      {tourEl}

      {/* Due-now reminders show where they belong — Today and Overdue — not on every list. */}
      {tasksShown && !capture && (list === "today" || list === "overdue") && (
        <DueNowCard tasks={firing} actions={actions} now={now} locale={LOCALE} compact />
      )}

      {captureEl}
      {searchEl}

      <main className={tasksShown && (upcoming || todayHours) ? "panel-body week" : "panel-body"}>
        {tasksShown && upcoming && (
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
            onAdd={addFromPlan}
            onOpen={showInList}
          />
        )}
        {tasksShown && todayHours && (
          <div className="week-view today-hours">
            {adding && (
              <AddTaskForm
                locale={LOCALE}
                defaultDay={today}
                projects={projectInfos.map((p) => p.name)}
                placeholder="What needs doing? Try “call Sam 3pm”"
                onAdd={async (t) => {
                  await addFromPlan(t);
                  setAdding(false);
                }}
                onCancel={() => setAdding(false)}
              />
            )}
            <DayPlan
              tasks={tasks}
              day={today}
              today={today}
              now={now}
              locale={LOCALE}
              events={todayEvents}
              actions={actions}
              drag={drag}
              onAdd={addFromPlan}
              onOpen={showInList}
            />
          </div>
        )}
        {listEl}
        {settingsEl}
      </main>

      {tab === "tasks" && showList && selectedTasks.length > 0 && (
        <BatchBar tasks={selectedTasks} actions={actions} projects={projectInfos} onClear={() => setSelected(new Set())} />
      )}
      <Toasts toasts={toasts} onDismiss={dismiss} />
      {drag.drag && <DragGhost drag={drag.drag} now={now} locale={LOCALE} />}

      {keysSheet}

      <footer className="panel-foot" data-tauri-drag-region>
        <span className="local-dot" aria-hidden />
        <span className="foot-text" data-tauri-drag-region>
          On this Mac · {captureHint} to capture
        </span>
        <button type="button" className="foot-keys" onClick={() => setShowKeys(true)} title="Keyboard shortcuts">
          ?
        </button>
      </footer>
    </div>
    </ProjectColors.Provider>
  );
}

/** The current list's icon, for full screen's header. */
function ListIcon({ list, stats }: { list: ListId; stats?: ProjectSummary }) {
  if (projectOf(list) !== null) return <Pie done={stats?.done ?? 0} total={(stats?.done ?? 0) + (stats?.open ?? 0)} size={18} />;
  if (list === "today") return <StarIcon />;
  if (list === "upcoming") return <CalIcon />;
  if (list === "someday") return <CloudIcon />;
  if (list === "logbook") return <LogIcon />;
  if (list === "overdue") return <ClockIcon />;
  return <LinesIcon />;
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

function SidebarIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" aria-hidden fill="none" stroke="currentColor" strokeWidth="1.5">
      <rect x="2" y="2.5" width="12" height="11" rx="2" />
      <path d="M6 2.5v11" />
    </svg>
  );
}

