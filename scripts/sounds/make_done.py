"""Plucky's "done" sound: a soft tick, then two plucked notes rising a
perfect fourth (A5 -> D6, a V -> I cadence: the interval music uses to say
"finished"), with a short airy tail. ~0.5 s, mono, 48 kHz."""
import numpy as np, wave, sys
SR = 48000
DUR = 0.55
t = np.arange(int(SR * DUR)) / SR
rng = np.random.default_rng(7)

def pluck(f0, start, decay, gain):
    """A plucked/mallet tone: harmonic partials, higher ones dying faster."""
    x = np.zeros_like(t)
    tt = t - start
    on = tt >= 0
    tt = np.where(on, tt, 0)
    attack = np.minimum(tt / 0.003, 1.0)  # 3 ms: soft but crisp
    for k, a, d in [(1, 1.0, 1.0), (2, 0.32, 0.55), (3, 0.12, 0.35), (4, 0.05, 0.25)]:
        # A touch of inharmonicity makes it sound physical, not beepy.
        f = f0 * k * (1 + 0.0007 * k * k)
        x += a * np.sin(2 * np.pi * f * tt) * np.exp(-tt / (decay * d))
    # Very slight pitch settle at the onset (like a real pluck).
    return np.where(on, x * attack * gain, 0.0)

def tick(start, gain):
    """The tactile 'click' of the checkbox: 4 ms of filtered noise."""
    n = int(0.006 * SR)
    noise = rng.standard_normal(n)
    # Band-limit around 3-5 kHz with a simple resonant filter.
    y = np.zeros(n); y1 = y2 = 0.0
    f, r = 4200 / SR, 0.92
    c1, c2 = 2 * r * np.cos(2 * np.pi * f), -r * r
    for i in range(n):
        y0 = noise[i] + c1 * y1 + c2 * y2
        y[i] = y0; y2, y1 = y1, y0
    y *= np.exp(-np.arange(n) / (0.0012 * SR))
    out = np.zeros_like(t)
    s = int(start * SR)
    out[s:s + n] = y / np.max(np.abs(y)) * gain
    return out

sig = tick(0.0, 0.35)
sig += pluck(880.00, 0.004, 0.075, 0.55)   # A5, short
sig += pluck(1174.66, 0.078, 0.16, 0.62)   # D6, rings out: the "resolved" note
# A quiet octave sparkle on the last note, for brightness without harshness.
sig += pluck(2349.32, 0.080, 0.06, 0.06)

# A tiny room: a few early reflections, ~12% wet.
wet = np.zeros_like(sig)
for ms, g in [(11, 0.35), (17, 0.25), (29, 0.18), (43, 0.12), (61, 0.08)]:
    d = int(ms * SR / 1000)
    wet[d:] += sig[:-d] * g
sig = sig + 0.12 * wet

# Fade the tail to silence, then normalize to -3 dBFS.
fade = int(0.08 * SR)
sig[-fade:] *= np.linspace(1, 0, fade) ** 2
sig = sig / np.max(np.abs(sig)) * (10 ** (-3 / 20))

out = sys.argv[1] if len(sys.argv) > 1 else "done.wav"
pcm = (sig * 32767).astype(np.int16)
with wave.open(out, "wb") as w:
    w.setnchannels(1); w.setsampwidth(2); w.setframerate(SR); w.writeframes(pcm.tobytes())
print(out, len(pcm) / SR, "s", pcm.nbytes // 1024, "KB")
