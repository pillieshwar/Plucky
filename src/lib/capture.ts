import { api } from "./api";
import type { CaptureState } from "../components/CaptureCard";
import type { CaptureResult, Status } from "./types";

/**
 * Turn a capture into the review card's states: a notice for failures,
 * otherwise "reading it…" and then the model's suggestion (or a manual edit
 * when there's no model or extraction fails). Shared by the side panel and
 * the menu-bar dropdown. `isCurrent` drops results of an older capture.
 */
export async function processCapture(
  result: CaptureResult,
  status: Status | null,
  set: (s: CaptureState) => void,
  isCurrent: () => boolean,
): Promise<void> {
  if (result.kind !== "text") {
    set({ phase: "notice", result });
    return;
  }
  const selection = result.text;
  const source = result.source;
  if (status && status.engine === "bundled" && !status.active_model) {
    set({
      phase: "manual",
      selection,
      source,
      error: "No model downloaded yet — add this one by hand, or get a model in Settings → AI model.",
    });
    return;
  }
  set({ phase: "extracting", selection, source });
  try {
    const extraction = await api.extract(selection);
    if (isCurrent()) set({ phase: "review", selection, source, extraction });
  } catch (e) {
    if (isCurrent()) set({ phase: "manual", selection, source, error: String(e) });
  }
}
