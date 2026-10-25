import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import type { ShortcutAction, ShortcutSettings, ShortcutSpec } from "./shortcuts";
import type {
  AgentsStatus,
  WatchStatus,
  EmailTasksStatus,
  InboxItem,
  PopoverFocus,
  AppSettings,
  BackupInfo,
  CalendarEvent,
  CalendarInfo,
  CalendarStatus,
  CityWindow,
  FloorSummary,
  CaptureResult,
  CustomModelInfo,
  DownloadEvent,
  Extraction,
  LocalModels,
  ModelInfo,
  NewTask,
  NotificationPermission,
  RemindersAccess,
  RemindersEnableRequest,
  RemindersList,
  RemindersStatus,
  Status,
  Task,
  ProjectSummary,
  TaskPatch,
  UpdateStatus,
} from "./types";

export const api = {
  extract: (selection: string) => invoke<Extraction>("extract", { selection }),
  listTasks: (doneSince: string | null) => invoke<Task[]>("list_tasks", { doneSince }),
  addTask: (task: NewTask) => invoke<Task>("add_task", { task }),
  updateTask: (id: number, patch: TaskPatch) => invoke<Task>("update_task", { id, patch }),
  logbook: (before: string | null, limit = 80) => invoke<Task[]>("logbook", { before, limit }),
  cityWindows: () => invoke<CityWindow[]>("city_windows"),
  listFloors: () => invoke<FloorSummary[]>("list_floors"),
  createProject: (name: string) => invoke<string | null>("create_project", { name }),
  addFloor: (project: string, name: string) => invoke<string | null>("add_floor", { project, name }),
  renameFloor: (project: string, from: string, to: string) => invoke<number>("rename_floor", { project, from, to }),
  /** Give a project its own color (`#rrggbb`), or clear it with null. */
  setProjectColor: (name: string, color: string | null) => invoke<void>("set_project_color", { name, color }),
  /** Every task in a project, done ones too. */
  projectTasks: (project: string) => invoke<Task[]>("project_tasks", { project }),
  /** Take down an empty project (false while it has tasks). */
  deleteProject: (name: string) => invoke<boolean>("delete_project", { name }),
  /** Take down an empty floor (false while it has tasks). */
  deleteFloor: (project: string, name: string) => invoke<boolean>("delete_floor", { project, name }),
  /** Save a PNG of the city to Downloads and show it; returns the path. */
  saveCityImage: (name: string, png: Uint8Array) => invoke<string>("save_city_image", { name, png: Array.from(png) }),
  listProjects: () => invoke<ProjectSummary[]>("list_projects"),
  skipOccurrence: (id: number) => invoke<Task>("skip_occurrence", { id }),
  renameProject: (from: string, to: string) => invoke<number>("rename_project", { from, to }),
  deleteTask: (id: number) => invoke<void>("delete_task", { id }),
  status: () => invoke<Status>("status"),
  requestAccessibility: () => invoke<boolean>("request_accessibility"),
  hidePanel: () => invoke<void>("hide_panel"),
  listModels: () => invoke<ModelInfo[]>("list_models"),
  downloadModel: (id: string) => invoke<void>("download_model", { id }),
  cancelDownload: (id: string) => invoke<void>("cancel_download", { id }),
  deleteModel: (id: string) => invoke<void>("delete_model", { id }),
  setActiveModel: (id: string) => invoke<void>("set_active_model", { id }),
  setPanelCollapsed: (collapsed: boolean) => invoke<void>("set_panel_collapsed", { collapsed }),
  /** Open the panel as a full-screen window, or put it back at the side. */
  setPanelFull: (full: boolean) => invoke<void>("set_panel_full", { full }),
  /** Full screen: minimize the window to the Dock. */
  minimizePanel: () => invoke<void>("minimize_panel"),
  panelFull: () => invoke<boolean>("panel_full"),
  snapPanelToEdge: () => invoke<void>("snap_panel_to_edge"),
  listLocalModels: () => invoke<LocalModels>("list_local_models"),
  addModelFile: (path: string, source: string | null = null) =>
    invoke<CustomModelInfo>("add_model_file", { path, source }),
  removeModelFile: (id: string) => invoke<void>("remove_model_file", { id }),
  getShortcuts: () => invoke<ShortcutSettings>("get_shortcuts"),
  setShortcut: (action: ShortcutAction, spec: ShortcutSpec | null) =>
    invoke<ShortcutSettings>("set_shortcut", { action, spec }),
  resetShortcuts: () => invoke<ShortcutSettings>("reset_shortcuts"),
  pauseShortcuts: (paused: boolean) => invoke<void>("pause_shortcuts", { paused }),
  revealLogs: () => invoke<string>("reveal_logs"),
  openMain: (taskId: number | null, tab: string | null) => invoke<void>("open_main", { taskId, tab }),
  hidePopover: () => invoke<void>("hide_popover"),
  setPopoverPinned: (pinned: boolean) => invoke<void>("set_popover_pinned", { pinned }),
  remindersStatus: () => invoke<RemindersStatus>("reminders_status"),
  remindersRequestAccess: () => invoke<RemindersAccess>("reminders_request_access"),
  remindersLists: () => invoke<RemindersList[]>("reminders_lists"),
  remindersEnable: (request: RemindersEnableRequest) => invoke<void>("reminders_enable", { request }),
  remindersDisable: () => invoke<void>("reminders_disable"),
  remindersSyncNow: () => invoke<void>("reminders_sync_now"),
  remindersSetIncludeNotes: (include: boolean) => invoke<void>("reminders_set_include_notes", { include }),
  remindersOpenPrivacySettings: () => invoke<void>("reminders_open_privacy_settings"),
  calendarStatus: () => invoke<CalendarStatus>("calendar_status"),
  calendarRequestAccess: () => invoke<RemindersAccess>("calendar_request_access"),
  calendarCalendars: () => invoke<CalendarInfo[]>("calendar_calendars"),
  calendarSet: (enabled: boolean, hidden: string[]) => invoke<CalendarStatus>("calendar_set", { enabled, hidden }),
  /** Events for the days `from..=to` (YYYY-MM-DD); empty when Calendar isn't connected. */
  calendarEvents: (from: string, to: string) => invoke<CalendarEvent[]>("calendar_events", { from, to }),
  calendarOpenPrivacySettings: () => invoke<void>("calendar_open_privacy_settings"),
  openSource: (id: number) => invoke<void>("open_source", { id }),
  openUrl: (url: string) => invoke<void>("open_url", { url }),
  restoreTask: (task: Task) => invoke<Task>("restore_task", { task }),
  agentsStatus: () => invoke<AgentsStatus>("agents_status"),
  agentsSetEnabled: (enabled: boolean) => invoke<AgentsStatus>("agents_set_enabled", { enabled }),
  agentsSetProactive: (on: boolean) => invoke<AgentsStatus>("agents_set_proactive", { on }),
  /** One app by id, or "all" installed apps. Also turns agent access on. */
  agentsConnect: (id: string) => invoke<AgentsStatus>("agents_connect", { id }),
  agentsDisconnect: (id: string) => invoke<AgentsStatus>("agents_disconnect", { id }),
  /** Send a test task through `Pluck --mcp`; resolves with a message. */
  agentsTest: () => invoke<string>("agents_test"),
  emailTasksStatus: () => invoke<EmailTasksStatus>("email_tasks_status"),
  emailTasksSet: (change: {
    enabled: boolean;
    start: string;
    end: string;
    interval: number;
    weekdays_only: boolean;
    server: string | null;
  }) => invoke<EmailTasksStatus>("email_tasks_set", { change }),
  emailTasksRunNow: () => invoke<EmailTasksStatus>("email_tasks_run_now"),
  inboxList: () => invoke<InboxItem[]>("inbox_list"),
  /** `schedule`: a date worked out from the item's date_text. */
  inboxAccept: (id: number, schedule?: { due_date: string | null; due_time: string | null }) =>
    invoke<Task>("inbox_accept", { id, schedule: schedule ?? null }),
  watchStatus: () => invoke<WatchStatus>("watch_status"),
  watchSet: (change: {
    enabled: boolean;
    excluded: string[];
    plugged_in_only: boolean;
    show_right_away: boolean;
    names: Record<string, string>;
  }) =>
    invoke<WatchStatus>("watch_set", { change }),
  /** Pause for `minutes`, or resume with 0. */
  watchPause: (minutes: number) => invoke<WatchStatus>("watch_pause", { minutes }),
  /** Look at the latest messages in the watched app in front; resolves with a message. */
  watchCheckNow: () => invoke<string>("watch_check_now"),
  inboxDiscard: (id: number) => invoke<void>("inbox_discard", { id }),
  getSettings: () => invoke<AppSettings>("get_settings"),
  setSettings: (value: AppSettings) => invoke<AppSettings>("set_settings", { value }),
  notificationPermission: () => invoke<NotificationPermission>("notification_permission"),
  requestNotificationPermission: () => invoke<NotificationPermission>("request_notification_permission"),
  testNotification: () => invoke<void>("test_notification"),
  openNotificationSettings: () => invoke<void>("open_notification_settings"),
  autostartEnabled: () => invoke<boolean>("autostart_enabled"),
  setAutostart: (enabled: boolean) => invoke<boolean>("set_autostart", { enabled }),
  updateStatus: () => invoke<UpdateStatus>("update_status"),
  checkForUpdates: () => invoke<UpdateStatus>("check_for_updates"),
  installUpdate: () => invoke<void>("install_update"),
  listBackups: () => invoke<BackupInfo[]>("list_backups"),
  backupNow: () => invoke<BackupInfo[]>("backup_now"),
  restoreBackup: (name: string) => invoke<void>("restore_backup", { name }),
  revealBackups: () => invoke<void>("reveal_backups"),
  exportTasks: (format: "csv" | "json") => invoke<string>("export_tasks", { format }),
  showQuickAdd: () => invoke<void>("show_quick_add"),
  hideQuickAdd: () => invoke<void>("hide_quick_add"),
};

export function onUpdateStatus(handler: (s: UpdateStatus) => void): Promise<UnlistenFn> {
  return listen<UpdateStatus>("update-status", (e) => handler(e.payload));
}

/** The quick-add bar was just opened. */
export function onQuickShown(handler: () => void): Promise<UnlistenFn> {
  return listen("quick-shown", () => handler());
}

/** A capture sent to this window (the side panel or the menu-bar dropdown). */
export function onCapture(handler: (r: CaptureResult) => void): Promise<UnlistenFn> {
  return getCurrentWebviewWindow().listen<CaptureResult>("capture", (e) => handler(e.payload));
}

export function onTasksChanged(handler: () => void): Promise<UnlistenFn> {
  return listen("tasks-changed", () => handler());
}

export function onModelDownload(handler: (e: DownloadEvent) => void): Promise<UnlistenFn> {
  return listen<DownloadEvent>("model-download", (e) => handler(e.payload));
}

/** Tray menu → "Models…" asks the panel to switch tabs. */
export function onOpenTab(handler: (tab: string) => void): Promise<UnlistenFn> {
  return listen<string>("open-tab", (e) => handler(e.payload));
}

/** The panel was minimized or expanded (by us, a capture, or the tray). */
export function onPanelCollapsed(handler: (collapsed: boolean) => void): Promise<UnlistenFn> {
  return listen<boolean>("panel-collapsed", (e) => handler(e.payload));
}

export function onPanelFull(handler: (full: boolean) => void): Promise<UnlistenFn> {
  return listen<boolean>("panel-full", (e) => handler(e.payload));
}

export function onShortcutsChanged(handler: (s: ShortcutSettings) => void): Promise<UnlistenFn> {
  return listen<ShortcutSettings>("shortcuts-changed", (e) => handler(e.payload));
}

/** A task was picked from the menu-bar list. */
export function onHighlightTask(handler: (id: number) => void): Promise<UnlistenFn> {
  return listen<number>("highlight-task", (e) => handler(e.payload));
}

/** The menu-bar popover was just opened. */
export function onPopoverShown(handler: () => void): Promise<UnlistenFn> {
  return listen("popover-shown", () => handler());
}

/** Reminders sync status changed (a pass finished, settings changed…). */
export function onRemindersChanged(handler: () => void): Promise<UnlistenFn> {
  return listen("reminders-changed", () => handler());
}


/** The Calendar connector was turned on or off, or its calendars changed. */
export function onCalendarChanged(handler: () => void): Promise<UnlistenFn> {
  return listen("calendar-changed", () => handler());
}

/** The popover opened by itself on a due task or the undated check-in. */
export function onPopoverFocus(handler: (f: PopoverFocus) => void): Promise<UnlistenFn> {
  return getCurrentWebviewWindow().listen<PopoverFocus>("popover-focus", (e) => handler(e.payload));
}

/** Preferences changed (in any window). */
export function onSettingsChanged(handler: (s: AppSettings) => void): Promise<UnlistenFn> {
  return listen<AppSettings>("settings-changed", (e) => handler(e.payload));
}

/** Tasks from AI agents arrived or were reviewed. */
export function onInboxChanged(handler: () => void): Promise<UnlistenFn> {
  return listen("inbox-changed", () => handler());
}

/** A scheduled email check started or finished. */
export function onEmailTasksChanged(handler: () => void): Promise<UnlistenFn> {
  return listen("email-tasks-changed", () => handler());
}

/** Watch mode turned on/off, paused, or noticed something. */
export function onWatchChanged(handler: () => void): Promise<UnlistenFn> {
  return listen("watch-changed", () => handler());
}
