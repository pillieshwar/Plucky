/** Mirrors `pluck_core::Task`. */
export interface Task {
  id: number;
  title: string;
  due_date: string | null;
  source_text: string | null;
  done: boolean;
  created_at: string;
  created_tz: string | null;
  completed_at: string | null;
}

/** Mirrors `pluck_core::NewTask` (created_tz is filled in by Rust). */
export interface NewTask {
  title: string;
  due_date: string | null;
  source_text: string | null;
}

/** Mirrors `pluck_core::TaskPatch`. Omit a key to leave it unchanged. */
export interface TaskPatch {
  title?: string;
  due_date?: string | null;
  done?: boolean;
}

/** Mirrors `pluck_core::Extraction`. */
export interface Extraction {
  task: string;
  date_text: string | null;
  date_confidence: "high" | "low" | "none";
}

/** Mirrors `capture::CaptureResult` in the Tauri crate. */
export type CaptureResult =
  | { kind: "text"; text: string; method: "accessibility" | "clipboard" }
  | { kind: "nothing_selected" }
  | { kind: "permission_needed" }
  | { kind: "clipboard_busy" };

export interface Status {
  accessibility: boolean;
  model: string;
  model_reachable: boolean;
  model_error: string | null;
}
