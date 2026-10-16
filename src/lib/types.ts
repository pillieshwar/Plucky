/** Mirrors `pluck_core::Task`. */
export interface Task {
  id: number;
  title: string;
  due_date: string | null;
  /** `HH:MM`, only with a due date. */
  due_time: string | null;
  /** "daily" | "weekdays" | "weekly" | "biweekly" | "monthly" | "yearly" */
  recurrence: string | null;
  source_text: string | null;
  source_app: string | null;
  source_bundle: string | null;
  source_url: string | null;
  done: boolean;
  created_at: string;
  created_tz: string | null;
  completed_at: string | null;
  snoozed_until: string | null;
  notified_at: string | null;
  next_id: number | null;
  /** The user's description: links, details. */
  notes: string | null;
}

/** Mirrors `pluck_core::NewTask` (created_tz is filled in by Rust). */
export interface NewTask {
  title: string;
  due_date: string | null;
  due_time?: string | null;
  recurrence?: string | null;
  source_text: string | null;
  source_app?: string | null;
  source_bundle?: string | null;
  source_url?: string | null;
  notes?: string | null;
}

/** Mirrors `pluck_core::TaskPatch`. Omit a key to leave it unchanged. */
export interface TaskPatch {
  title?: string;
  due_date?: string | null;
  due_time?: string | null;
  recurrence?: string | null;
  snoozed_until?: string | null;
  notes?: string | null;
  done?: boolean;
}

/** Mirrors `pluck_core::Extraction`. */
export interface Extraction {
  task: string;
  date_text: string | null;
  date_confidence: "high" | "low" | "none";
}

/** Mirrors `capture::CaptureResult` in the Tauri crate. */
/** Mirrors `capture::SourceInfo`. */
export interface SourceInfo {
  app: string | null;
  bundle: string | null;
  url: string | null;
}

export type CaptureResult =
  | { kind: "text"; text: string; method: "accessibility" | "clipboard" | "service"; source: SourceInfo | null }
  | { kind: "nothing_selected" }
  | { kind: "permission_needed" }
  | { kind: "clipboard_busy" }
  | { kind: "failed"; message: string };

export interface Status {
  accessibility: boolean;
  /** "bundled" (default) or "ollama" (developer override). */
  engine: "bundled" | "ollama";
  /** Name of the model captures will use, or null if none is downloaded. */
  active_model: string | null;
  version: string;
  /** "macos" | "windows" | "linux" */
  platform: string;
}

/** Mirrors `pluck_core::notify::NotifySettings`. */
export interface NotifySettings {
  enabled: boolean;
  /** `HH:MM` — when to remind about tasks with a day but no time. */
  all_day_time: string;
  daily_summary: boolean;
}

/** Mirrors `settings::AppSettings`. */
export interface AppSettings {
  notify: NotifySettings;
  auto_update: boolean;
  remember_source: boolean;
  onboarding_done: boolean;
  autostart_initialized: boolean;
  last_summary: string | null;
  last_backup: string | null;
  seen_version: string | null;
  show_on_start: boolean;
  last_greeted: string | null;
  menubar_placed: boolean;
  capture_in_menu_bar: boolean;
}

export type NotificationPermission = "not_determined" | "denied" | "granted" | "unsupported";

/** Mirrors `updates::UpdateStatus`. */
export type UpdateStatus =
  | { state: "idle" }
  | { state: "checking" }
  | { state: "up_to_date" }
  | { state: "downloading"; version: string; percent: number | null }
  | { state: "ready"; version: string; notes: string | null }
  | { state: "failed"; message: string };

/** Mirrors `data::BackupInfo`. */
export interface BackupInfo {
  name: string;
  day: string;
  size: number;
}

/** Mirrors `models::ModelView` (catalog entry + local state). */
export interface ModelInfo {
  id: string;
  name: string;
  publisher: string;
  description: string;
  license: string;
  repo: string;
  file: string;
  approx_size_mb: number;
  min_ram_gb: number;
  recommended: boolean;
  installed: boolean;
  active: boolean;
  partial_bytes: number;
  progress: { downloaded: number; total: number } | null;
}

/** Mirrors `models::DownloadEvent`. */
export type DownloadEvent =
  | { state: "progress"; id: string; downloaded: number; total: number }
  | { state: "done"; id: string }
  | { state: "cancelled"; id: string }
  | { state: "failed"; id: string; error: string };

/** Mirrors `models::CustomModelView`: a model file the user added by path. */
export interface CustomModelInfo {
  id: string;
  name: string;
  path: string;
  size: number;
  source: string | null;
  active: boolean;
  /** False if the file was moved or deleted after it was added. */
  available: boolean;
}

/** Mirrors `local_models::FoundModel`: a model another app downloaded. */
export interface FoundModel {
  name: string;
  path: string;
  size: number;
  source: string;
}

export interface LocalModels {
  added: CustomModelInfo[];
  found: FoundModel[];
}

/** Mirrors `reminders::Access`. */
export type RemindersAccess = "not_determined" | "denied" | "restricted" | "full" | "write_only" | "unsupported";

/** Mirrors `reminders::ListInfo`. */
export interface RemindersList {
  id: string;
  title: string;
  /** "iCloud", "On My Mac", an Exchange account… */
  source: string;
  /** The list syncs off this Mac (iCloud or another account). */
  leaves_mac: boolean;
  icloud: boolean;
  writable: boolean;
}

/** Mirrors `reminders::Status`. */
export interface RemindersStatus {
  supported: boolean;
  access: RemindersAccess;
  enabled: boolean;
  include_notes: boolean;
  list: RemindersList | null;
  linked: number;
  last_sync: string | null;
  last_error: string | null;
}

/** Mirrors `slack::Status`. */
export interface SlackStatus {
  supported: boolean;
  connected: boolean;
  /** Waiting for the user to finish signing in in the browser. */
  connecting: boolean;
  needs_reconnect: boolean;
  team: string | null;
  user_id: string | null;
  error: string | null;
}

/** Mirrors `calendar::CalendarInfo`. */
export interface CalendarInfo {
  id: string;
  /** "Account / Title" — how Plucky remembers which calendars to hide. */
  key: string;
  title: string;
  source: string;
  color: string | null;
}

/** Mirrors `calendar::EventInfo`. Times are local `YYYY-MM-DDTHH:MM:SS`. */
export interface CalendarEvent {
  id: string;
  title: string;
  start: string;
  end: string;
  all_day: boolean;
  calendar: string;
  color: string | null;
}

/** Mirrors `calendar::Status`. */
export interface CalendarStatus {
  supported: boolean;
  access: RemindersAccess;
  enabled: boolean;
  /** Calendars turned off, by key. Everything else (and anything new) shows. */
  hidden: string[];
}

export interface RemindersEnableRequest {
  /** null = create a list called "Plucky". */
  list_id: string | null;
  include_notes: boolean;
  push_existing: boolean;
}
