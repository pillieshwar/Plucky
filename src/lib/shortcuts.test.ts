import { describe, expect, it } from "vitest";
import {
  formatShortcut,
  keyLabel,
  sameShortcut,
  shortcutWarning,
  specFromKeyEvent,
  validateShortcut,
  type ShortcutSpec,
} from "./shortcuts";

const s = (mods: string, code: string): ShortcutSpec => ({
  meta: mods.includes("cmd"),
  ctrl: mods.includes("ctrl"),
  alt: mods.includes("alt"),
  shift: mods.includes("shift"),
  code,
});

describe("formatting", () => {
  it("uses Apple's modifier order on macOS", () => {
    expect(formatShortcut(s("cmd shift", "KeyZ"), true)).toBe("⇧⌘Z");
    expect(formatShortcut(s("ctrl alt shift cmd", "Digit1"), true)).toBe("⌃⌥⇧⌘1");
  });

  it("uses words elsewhere", () => {
    expect(formatShortcut(s("ctrl shift", "KeyZ"), false)).toBe("Ctrl+Shift+Z");
    expect(formatShortcut(s("ctrl alt", "F5"), false)).toBe("Ctrl+Alt+F5");
  });

  it("labels keys", () => {
    expect(keyLabel("KeyQ")).toBe("Q");
    expect(keyLabel("Digit0")).toBe("0");
    expect(keyLabel("ArrowLeft")).toBe("←");
    expect(keyLabel("F12")).toBe("F12");
    expect(keyLabel("constructor")).toBe("constructor");
  });
});

describe("recording", () => {
  it("ignores modifier-only presses", () => {
    expect(specFromKeyEvent({ code: "ShiftLeft", metaKey: true, ctrlKey: false, altKey: false, shiftKey: true })).toBe(
      null,
    );
    expect(specFromKeyEvent({ code: "MetaRight", metaKey: true, ctrlKey: false, altKey: false, shiftKey: false })).toBe(
      null,
    );
  });

  it("captures modifiers and the key", () => {
    expect(specFromKeyEvent({ code: "KeyZ", metaKey: true, ctrlKey: false, altKey: false, shiftKey: true })).toEqual(
      s("cmd shift", "KeyZ"),
    );
  });
});

describe("validation", () => {
  it("accepts the default", () => {
    expect(validateShortcut(s("cmd shift", "KeyZ"), true)).toBe(null);
    expect(validateShortcut(s("ctrl shift", "KeyZ"), false)).toBe(null);
  });

  it("needs a real modifier", () => {
    expect(validateShortcut(s("shift", "KeyZ"), true)).toContain("Include");
    expect(validateShortcut(s("", "KeyZ"), true)).toContain("Include");
  });

  it("blocks system shortcuts", () => {
    expect(validateShortcut(s("cmd", "KeyC"), true)).toContain("system");
    expect(validateShortcut(s("cmd", "Space"), true)).toContain("system");
    expect(validateShortcut(s("cmd shift", "Digit4"), true)).toContain("screenshot");
    expect(validateShortcut(s("ctrl", "KeyV"), false)).toContain("system");
  });

  it("rejects keys TodoCity can't register", () => {
    expect(validateShortcut(s("cmd alt", "NumpadAdd"), true)).toContain("can't use");
  });
});

describe("warnings", () => {
  it("explains Redo on ⇧⌘Z", () => {
    expect(shortcutWarning(s("cmd shift", "KeyZ"), true)).toContain("Redo");
  });

  it("flags common app shortcuts", () => {
    expect(shortcutWarning(s("cmd", "KeyS"), true)).toContain("Save");
    expect(shortcutWarning(s("cmd shift", "KeyT"), true)).toContain("tabs");
  });

  it("is quiet for uncommon combos", () => {
    expect(shortcutWarning(s("ctrl alt cmd", "KeyT"), true)).toBe(null);
    expect(shortcutWarning(s("cmd", "toString"), true)).toBe(null);
  });
});

describe("sameShortcut", () => {
  it("compares all fields", () => {
    expect(sameShortcut(s("cmd shift", "KeyZ"), s("cmd shift", "KeyZ"))).toBe(true);
    expect(sameShortcut(s("cmd shift", "KeyZ"), s("cmd", "KeyZ"))).toBe(false);
    expect(sameShortcut(null, null)).toBe(true);
    expect(sameShortcut(null, s("cmd", "KeyZ"))).toBe(false);
  });
});
