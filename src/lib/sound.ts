import doneUrl from "../assets/done.wav";

/**
 * The check-off sound: a soft tick, then two plucked notes rising a perfect
 * fourth (A5 → D6) — the "finished" cadence — about half a second long.
 * Made for Plucky by scripts/sounds/make_done.py.
 */
let enabled = true;
let audio: HTMLAudioElement | null = null;
const lastPlayed = new Map<number, number>();

/** Follow the "Play a sound when a task is done" preference. */
export function setDoneSound(on: boolean) {
  enabled = on;
}

/** Load the sound ahead of the first check-off, so it plays instantly. */
function player(): HTMLAudioElement | null {
  if (audio) return audio;
  try {
    audio = new Audio(doneUrl);
    audio.preload = "auto";
    audio.volume = 0.45;
  } catch {
    audio = null;
  }
  return audio;
}

/**
 * Play the sound for a task checked off. Plays once per task even when both
 * the click and the save ask for it.
 */
export function playDone(taskId?: number) {
  if (!enabled) return;
  const now = Date.now();
  if (taskId !== undefined) {
    const last = lastPlayed.get(taskId) ?? 0;
    if (now - last < 1500) return;
    lastPlayed.set(taskId, now);
  }
  const a = player();
  if (!a) return;
  try {
    a.currentTime = 0;
    void a.play().catch(() => undefined);
  } catch {
    // No audio output: nothing to do.
  }
}

/** Warm up the audio element (call once at startup). */
export function preloadDone() {
  player()?.load();
}
