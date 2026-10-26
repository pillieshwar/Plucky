/**
 * The user's locale, validated. Some systems report tags Intl rejects (e.g.
 * "en-US@posix"); passing those to toLocaleDateString throws and would blank
 * the UI, so fall back to the language part, then to en-US.
 */
export function safeLocale(
  raw: string | undefined = typeof navigator !== "undefined" ? navigator.language : undefined,
): string {
  const candidates = [raw, raw?.split(/[@.]/)[0], raw?.split(/[-_@.]/)[0], "en-US"];
  for (const c of candidates) {
    if (!c) continue;
    try {
      const [canonical] = Intl.getCanonicalLocales(c.replace(/_/g, "-"));
      if (canonical) {
        new Intl.DateTimeFormat(canonical);
        return canonical;
      }
    } catch {
      // try the next candidate
    }
  }
  return "en-US";
}
