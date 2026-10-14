import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { ShortcutAction, ShortcutSettings, ShortcutSpec } from "./shortcuts";
import type {
  CaptureResult,
  CustomModelInfo,
  DownloadEvent,
  Extraction,
  LocalModels,
  ModelInfo,
  NewTask,
  RemindersAccess,
  RemindersEnableRequest,
  RemindersList,
  RemindersStatus,
  Status,
  Task,
  TaskPatch,
} from "./types";

export const api = {
  extract: (selection: string) => invoke<Extraction>("extract", { selection }),
  listTasks: (doneSince: string | null) => invoke<Task[]>("list_tasks", { doneSince }),
  addTask: (task: NewTask) => invoke<Task>("add_task", { task }),
  updateTask: (id: number, patch: TaskPatch) => invoke<Task>("update_task", { id, patch }),
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
  remindersStatus: () => invoke<RemindersStatus>("reminders_status"),
  remindersRequestAccess: () => invoke<RemindersAccess>("reminders_request_access"),
  remindersLists: () => invoke<RemindersList[]>("reminders_lists"),
  remindersEnable: (request: RemindersEnableRequest) => invoke<void>("reminders_enable", { request }),
  remindersDisable: () => invoke<void>("reminders_disable"),
  remindersSyncNow: () => invoke<void>("reminders_sync_now"),
  remindersSetIncludeNotes: (include: boolean) => invoke<void>("reminders_set_include_notes", { include }),
  remindersOpenPrivacySettings: () => invoke<void>("reminders_open_privacy_settings"),
};

export function onCapture(handler: (r: CaptureResult) => void): Promise<UnlistenFn> {
  return listen<CaptureResult>("capture", (e) => handler(e.payload));
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
