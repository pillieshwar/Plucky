import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { CaptureResult, Extraction, NewTask, Status, Task, TaskPatch } from "./types";

export const api = {
  extract: (selection: string) => invoke<Extraction>("extract", { selection }),
  listTasks: (doneSince: string | null) => invoke<Task[]>("list_tasks", { doneSince }),
  addTask: (task: NewTask) => invoke<Task>("add_task", { task }),
  updateTask: (id: number, patch: TaskPatch) => invoke<Task>("update_task", { id, patch }),
  deleteTask: (id: number) => invoke<void>("delete_task", { id }),
  status: () => invoke<Status>("status"),
  requestAccessibility: () => invoke<boolean>("request_accessibility"),
  hidePanel: () => invoke<void>("hide_panel"),
};

export function onCapture(handler: (r: CaptureResult) => void): Promise<UnlistenFn> {
  return listen<CaptureResult>("capture", (e) => handler(e.payload));
}

export function onTasksChanged(handler: () => void): Promise<UnlistenFn> {
  return listen("tasks-changed", () => handler());
}
