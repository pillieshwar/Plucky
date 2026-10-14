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
  /** "bundled" (default) or "ollama" (developer override). */
  engine: "bundled" | "ollama";
  /** Name of the model captures will use, or null if none is downloaded. */
  active_model: string | null;
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
