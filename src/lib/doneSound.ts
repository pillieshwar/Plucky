/**
 * "Lights on": the sound of finishing a task. A wall switch clicks, then a
 * warm two-note chime rises, as a window in the city lights up. Made live
 * with Web Audio (no audio files), about a second long, kept quiet so it
 * sits under music and calls.
 */

let enabled = true;
let ctx: AudioContext | null = null;
let out: GainNode | null = null;
let noiseBuf: AudioBuffer | null = null;
/** Recently played, by task: a click and the save that follows play once. */
const recent = new Map<number, number>();
let lastAt = 0;

/** Follow Settings → Notifications → "Play a sound when a task is done". */
export function setDoneSound(on: boolean | undefined) {
  enabled = on !== false;
}

function audio(): AudioContext | null {
  try {
    if (!ctx) {
      const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!AC) return null;
      ctx = new AC();
      const comp = ctx.createDynamicsCompressor();
      comp.threshold.value = -14;
      comp.ratio.value = 4;
      out = ctx.createGain();
      out.gain.value = 0.7;
      out.connect(comp).connect(ctx.destination);
    }
    if (ctx.state === "suspended") void ctx.resume();
    return ctx;
  } catch {
    return null;
  }
}

function env(p: AudioParam, t: number, attack: number, peak: number, decay: number) {
  p.setValueAtTime(0.0001, t);
  p.exponentialRampToValueAtTime(peak, t + attack);
  p.exponentialRampToValueAtTime(0.0001, t + attack + decay);
}

function tone(c: AudioContext, freq: number, t: number, decay: number, peak: number, type: OscillatorType = "sine") {
  const o = c.createOscillator();
  const g = c.createGain();
  o.type = type;
  o.frequency.value = freq;
  env(g.gain, t, 0.006, peak, decay);
  o.connect(g).connect(out!);
  o.start(t);
  o.stop(t + decay + 0.06);
}

function click(c: AudioContext, t: number, freq: number, peak: number) {
  if (!noiseBuf) {
    noiseBuf = c.createBuffer(1, Math.floor(c.sampleRate * 0.1), c.sampleRate);
    const d = noiseBuf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  }
  const s = c.createBufferSource();
  const f = c.createBiquadFilter();
  const g = c.createGain();
  s.buffer = noiseBuf;
  f.type = "bandpass";
  f.frequency.value = freq;
  f.Q.value = 2;
  env(g.gain, t, 0.001, peak, 0.02);
  s.connect(f).connect(g).connect(out!);
  s.start(t);
  s.stop(t + 0.06);
}

/**
 * Play it for finishing `taskId` (once, even if the click and the save both
 * ask). Several at once — "Complete all" — play it once.
 */
export function playDone(taskId?: number) {
  if (!enabled) return;
  const now = performance.now();
  if (taskId !== undefined) {
    const at = recent.get(taskId);
    if (at !== undefined && now - at < 2000) return;
    recent.set(taskId, now);
    if (recent.size > 50) recent.clear();
  }
  // Ticking quickly through a list: no pile-up.
  if (now - lastAt < 90) return;
  lastAt = now;
  const c = audio();
  if (!c || !out) return;
  const t = c.currentTime + 0.01;
  click(c, t, 3200, 0.45);
  click(c, t + 0.03, 1800, 0.25);
  tone(c, 659.25, t + 0.06, 0.85, 0.17);
  tone(c, 329.63, t + 0.06, 0.6, 0.05, "triangle");
  tone(c, 987.77, t + 0.14, 1.0, 0.13);
  tone(c, 1975.5, t + 0.14, 0.5, 0.02);
}

/** Play it once from Settings, even while it's switched off. */
export function previewDone() {
  const was = enabled;
  enabled = true;
  lastAt = 0;
  playDone();
  enabled = was;
}
