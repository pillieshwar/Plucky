/** Mirrors `shortcuts::ShortcutSpec` in Rust. */
export interface ShortcutSpec {
  /** ⌘ on macOS, the Windows key on Windows. */
  meta: boolean;
  ctrl: boolean;
  /** ⌥ Option / Alt */
  alt: boolean;
  shift: boolean;
  /** W3C key code, e.g. "KeyZ". */
  code: string;
}

export interface ShortcutSettings {
  capture: ShortcutSpec;
  toggle_panel: ShortcutSpec | null;
}

export type ShortcutAction = "capture" | "toggle_panel";

export function isMacPlatform(): boolean {
  return typeof navigator !== "undefined" && /Mac/i.test(navigator.platform);
}

const KEY_LABELS: Record<string, string> = {
  Space: "Space",
  ArrowUp: "↑",
  ArrowDown: "↓",
  ArrowLeft: "←",
  ArrowRight: "→",
  Enter: "↩",
  Backspace: "⌫",
  Tab: "⇥",
  Escape: "Esc",
  Comma: ",",
  Period: ".",
  Slash: "/",
  Semicolon: ";",
  Quote: "'",
  BracketLeft: "[",
  BracketRight: "]",
  Backslash: "\\",
  Backquote: "`",
  Minus: "-",
  Equal: "=",
};

export function keyLabel(code: string): string {
  if (code.startsWith("Key")) return code.slice(3);
  if (code.startsWith("Digit")) return code.slice(5);
  return Object.prototype.hasOwnProperty.call(KEY_LABELS, code) ? KEY_LABELS[code] : code;
}

/** "⇧⌘Z" on macOS (Apple's ⌃⌥⇧⌘ order), "Ctrl+Shift+Z" elsewhere. */
export function formatShortcut(spec: ShortcutSpec, mac = isMacPlatform()): string {
  const key = keyLabel(spec.code);
  if (mac) {
    return `${spec.ctrl ? "⌃" : ""}${spec.alt ? "⌥" : ""}${spec.shift ? "⇧" : ""}${spec.meta ? "⌘" : ""}${key}`;
  }
  const parts: string[] = [];
  if (spec.ctrl) parts.push("Ctrl");
  if (spec.meta) parts.push("Win");
  if (spec.alt) parts.push("Alt");
  if (spec.shift) parts.push("Shift");
  parts.push(key);
  return parts.join("+");
}

const MODIFIER_CODE = /^(Meta|Control|Alt|Shift|OS|CapsLock|Fn)/;

/** Keys Pluck can register (kept in step with `parse_code` in Rust). */
const SUPPORTED = new Set([
  ..."ABCDEFGHIJKLMNOPQRSTUVWXYZ".split("").map((c) => `Key${c}`),
  ..."0123456789".split("").map((d) => `Digit${d}`),
  ...Array.from({ length: 12 }, (_, i) => `F${i + 1}`),
  ...Object.keys(KEY_LABELS),
]);

interface KeyLike {
  code: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}

/** Turn a keydown into a spec; null while only modifiers are held. */
export function specFromKeyEvent(e: KeyLike): ShortcutSpec | null {
  if (!e.code || MODIFIER_CODE.test(e.code)) return null;
  return { meta: e.metaKey, ctrl: e.ctrlKey, alt: e.altKey, shift: e.shiftKey, code: e.code };
}

function primaryOnly(s: ShortcutSpec, mac: boolean): boolean {
  const primary = mac ? s.meta && !s.ctrl : s.ctrl && !s.meta;
  return primary && !s.alt && !s.shift;
}

/** Same rules as `ShortcutSpec::validate` in Rust; returns an error message or null. */
export function validateShortcut(s: ShortcutSpec, mac = isMacPlatform()): string | null {
  if (!(s.meta || s.ctrl || s.alt)) {
    return `Include ${mac ? "⌘, ⌃ or ⌥" : "Ctrl or Alt"} so the shortcut doesn't fire while you type.`;
  }
  if (!SUPPORTED.has(s.code)) return `Pluck can't use that key in a shortcut. Try a letter, number or F-key.`;
  const reserved = ["KeyC", "KeyV", "KeyX", "KeyA", "KeyZ", "KeyQ", "KeyW", "Tab", "Space"];
  if (primaryOnly(s, mac) && reserved.includes(s.code)) {
    return `${formatShortcut(s, mac)} is used by the system for basic editing or switching apps.`;
  }
  if (mac && s.meta && s.shift && !s.alt && !s.ctrl && ["Digit3", "Digit4", "Digit5"].includes(s.code)) {
    return `${formatShortcut(s, mac)} is the macOS screenshot shortcut.`;
  }
  return null;
}

const PRIMARY_USES: Record<string, string> = {
  KeyS: "Save",
  KeyF: "Find",
  KeyN: "New",
  KeyT: "New tab",
  KeyP: "Print",
  KeyO: "Open",
  KeyR: "Reload",
  KeyH: "Hide",
  KeyM: "Minimize",
  KeyL: "Go to address bar",
  KeyB: "Bold",
  KeyI: "Italic",
  KeyU: "Underline",
  KeyK: "Insert link",
  KeyG: "Find next",
  KeyD: "Bookmark",
  KeyY: "History",
  KeyE: "Use selection for Find",
  KeyJ: "Downloads",
  Comma: "Settings",
};

/**
 * A heads-up when a shortcut overrides something common. Pluck still allows
 * it — while Pluck runs, the shortcut is Pluck's in every app.
 */
export function shortcutWarning(s: ShortcutSpec, mac = isMacPlatform()): string | null {
  const label = formatShortcut(s, mac);
  const primary = mac ? s.meta && !s.ctrl : s.ctrl && !s.meta;
  if (primary && s.shift && !s.alt && s.code === "KeyZ") {
    return `${label} is Redo in most apps. While Pluck uses it, Redo by shortcut won't work elsewhere — use the Edit menu, or pick another shortcut here.`;
  }
  if (primary && s.shift && !s.alt && s.code === "KeyT") {
    return `${label} reopens closed tabs in browsers.`;
  }
  if (primaryOnly(s, mac) && Object.prototype.hasOwnProperty.call(PRIMARY_USES, s.code)) {
    return `${label} is ${PRIMARY_USES[s.code]} in many apps, and won't work there while Pluck uses it.`;
  }
  if (s.ctrl && !s.meta && !s.shift && s.code === "Space" && mac) {
    return `${label} switches keyboard input sources on macOS.`;
  }
  return null;
}

export function sameShortcut(a: ShortcutSpec | null, b: ShortcutSpec | null): boolean {
  if (!a || !b) return a === b;
  return a.meta === b.meta && a.ctrl === b.ctrl && a.alt === b.alt && a.shift === b.shift && a.code === b.code;
}
