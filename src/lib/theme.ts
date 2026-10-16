import type { Theme } from "./types";

/**
 * Apply the Appearance preference to this window. "system" follows macOS;
 * light and dark pin the palette (see the `data-theme` rules in styles.css).
 */
export function applyTheme(theme: Theme | string | null | undefined): void {
  const root = document.documentElement;
  if (theme === "light" || theme === "dark") {
    root.dataset.theme = theme;
    root.style.colorScheme = theme;
  } else {
    delete root.dataset.theme;
    root.style.colorScheme = "";
  }
}
