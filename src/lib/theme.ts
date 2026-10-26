import type { Theme } from "./types";

/**
 * Apply the Appearance preference to this window. "system" follows macOS;
 * light and dark pin the palette (see the `data-theme` rules in styles.css).
 */
export function applyTheme(theme: Theme | string | null | undefined): void {
  const root = document.documentElement;
  try {
    if (theme) localStorage.setItem("todocity.theme", theme);
  } catch {
    // Storage unavailable: the next launch starts dark until settings load.
  }
  if (theme === "light" || theme === "dark") {
    root.dataset.theme = theme;
    root.style.colorScheme = theme;
  } else {
    delete root.dataset.theme;
    root.style.colorScheme = "";
  }
}

/** The last Appearance used in this window (dark before settings ever load). */
export function cachedTheme(): string {
  try {
    return localStorage.getItem("todocity.theme") ?? "dark";
  } catch {
    return "dark";
  }
}
