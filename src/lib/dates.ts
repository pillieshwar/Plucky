/**
 * Deterministic date resolution.
 *
 * The model only copies the date phrase it saw ("by Friday"); this module
 * turns that phrase into a calendar day against the *real* local date. It is
 * deliberately narrow — deadline language, not a general NLP date parser —
 * and it reports ambiguity instead of guessing silently, so the panel can ask.
 *
 * All dates are local calendar days formatted `YYYY-MM-DD`. Weeks start on
 * Monday.
 */

export type ModelConfidence = "high" | "low" | "none";

export interface DateResolution {
  /** Best reading, or null when the phrase has no usable date. */
  date: string | null;
  /** Other plausible readings, most likely first. */
  alternatives: string[];
  /** True only when the phrase is specific and unambiguous. */
  confident: boolean;
}

export type DayOrder = "MDY" | "DMY";

const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
const WEEKDAY_ALIASES: Record<string, number> = {
  sun: 0, sunday: 0,
  mon: 1, monday: 1,
  tue: 2, tues: 2, tuesday: 2,
  wed: 3, weds: 3, wednesday: 3,
  thu: 4, thur: 4, thurs: 4, thursday: 4,
  fri: 5, friday: 5,
  sat: 6, saturday: 6,
};
const MONTHS: Record<string, number> = {
  jan: 0, january: 0, feb: 1, february: 1, mar: 2, march: 2, apr: 3, april: 3,
  may: 4, jun: 5, june: 5, jul: 6, july: 6, aug: 7, august: 7,
  sep: 8, sept: 8, september: 8, oct: 9, october: 9, nov: 10, november: 10,
  dec: 11, december: 11,
};
const NUMBER_WORDS: Record<string, number> = {
  a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7,
  eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, couple: 2, few: 3,
};

function own<T>(table: Record<string, T>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(table, key);
}

// ── Calendar helpers (local time, no time-of-day) ───────────────────────────

export function toISODate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export function parseISODate(s: string): Date {
  const [y, m, d] = s.split("-").map(Number);
  return new Date(y, m - 1, d);
}

export function startOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

export function addDays(d: Date, n: number): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
}

export function daysBetween(a: Date, b: Date): number {
  // Round to absorb DST hour shifts.
  return Math.round((startOfDay(b).getTime() - startOfDay(a).getTime()) / 86_400_000);
}

/** Monday-based index: Mon=0 … Sun=6. */
function mondayIndex(d: Date): number {
  return (d.getDay() + 6) % 7;
}

function startOfWeek(d: Date): Date {
  return addDays(d, -mondayIndex(d));
}

function lastDayOfMonth(year: number, month: number): Date {
  return new Date(year, month + 1, 0);
}

function validDate(y: number, m: number, d: number): Date | null {
  const dt = new Date(y, m, d);
  return dt.getFullYear() === y && dt.getMonth() === m && dt.getDate() === d ? dt : null;
}

/** Next occurrence of `weekday` on or after `from`. */
function upcoming(from: Date, weekday: number): Date {
  return addDays(from, (weekday - from.getDay() + 7) % 7);
}

// ── Phrase normalization ────────────────────────────────────────────────────

export function normalize(text: string): string {
  let t = text.toLowerCase().trim();
  t = t.replace(/[.,!?;:]+$/g, "");
  t = t.replace(/(\d)(st|nd|rd|th)\b/g, "$1");
  // Leading deadline words.
  t = t.replace(/^(no later than|not later than|by|before|due|on|until|till|for|at)\s+/g, "");
  t = t.replace(/^(the)\s+/, "");
  // Trailing time-of-day noise: "friday eod", "friday at 5pm", "friday morning".
  t = t.replace(
    /\s+(eod|cob|eob|end of (the )?(business )?day|close of business|(at|by|@)\s*\d{1,2}(:\d{2})?\s*(am|pm)?|\d{1,2}(:\d{2})?\s*(am|pm)|morning|afternoon|evening|night|noon|midday)$/g,
    "",
  );
  return t.replace(/\s+/g, " ").trim();
}

// ── Resolution ──────────────────────────────────────────────────────────────

function result(date: Date | null, confident: boolean, alternatives: Date[] = []): DateResolution {
  return {
    date: date ? toISODate(date) : null,
    alternatives: alternatives.map(toISODate),
    confident: confident && date !== null,
  };
}

function parseCount(word: string): number | null {
  if (/^\d+$/.test(word)) return Number(word);
  return own(NUMBER_WORDS, word) ? NUMBER_WORDS[word] : null;
}

/**
 * Resolve a date phrase against `reference` (normally "now").
 * `order` decides how `3/4` is read; ambiguous numeric dates always carry the
 * other reading as an alternative.
 */
export function resolveDatePhrase(
  phrase: string,
  reference: Date,
  order: DayOrder = "MDY",
): DateResolution {
  const today = startOfDay(reference);
  const t = normalize(phrase);
  if (!t) return result(null, false);

  // Relative days.
  if (/^(today|tonight|eod|end of (the )?day|cob|this evening|this afternoon|this morning)$/.test(t))
    return result(today, true);
  if (/^(tomorrow|tmrw|tmr|tom)$/.test(t)) return result(addDays(today, 1), true);
  if (/^(the )?day after tomorrow$/.test(t)) return result(addDays(today, 2), true);

  // "in 3 days", "in two weeks", "in a week"
  let m = t.match(/^in (\S+) (business days?|days?|weeks?|months?)$/);
  if (m) {
    const n = parseCount(m[1]);
    if (n !== null) {
      if (m[2].startsWith("business")) {
        let d = today;
        for (let left = n; left > 0; ) {
          d = addDays(d, 1);
          if (d.getDay() !== 0 && d.getDay() !== 6) left--;
        }
        return result(d, true);
      }
      if (m[2].startsWith("day")) return result(addDays(today, n), true);
      if (m[2].startsWith("week")) return result(addDays(today, 7 * n), true);
      const target = new Date(today.getFullYear(), today.getMonth() + n, 1);
      const day = Math.min(today.getDate(), lastDayOfMonth(target.getFullYear(), target.getMonth()).getDate());
      return result(new Date(target.getFullYear(), target.getMonth(), day), false);
    }
  }

  // Weeks.
  if (/^(end of (the |this )?week|eow|this week)$/.test(t)) {
    const friday = addDays(startOfWeek(today), 4);
    // Past Friday already: the phrase most likely means the coming one.
    if (daysBetween(today, friday) < 0) return result(addDays(friday, 7), false);
    return result(friday, t !== "this week");
  }
  if (/^(end of )?next week$/.test(t)) {
    const nextMonday = addDays(startOfWeek(today), 7);
    return t.startsWith("end") ? result(addDays(nextMonday, 4), true) : result(nextMonday, false);
  }
  if (/^(the )?weekend$|^this weekend$/.test(t)) {
    // Said on a Sunday, "the weekend" is today; otherwise the coming Saturday.
    return result(today.getDay() === 0 ? today : addDays(startOfWeek(today), 5), false);
  }

  // Months.
  if (/^(end of (the |this )?month|eom)$/.test(t))
    return result(lastDayOfMonth(today.getFullYear(), today.getMonth()), true);
  if (/^end of next month$/.test(t))
    return result(lastDayOfMonth(today.getFullYear(), today.getMonth() + 1), true);
  if (/^next month$/.test(t)) return result(new Date(today.getFullYear(), today.getMonth() + 1, 1), false);

  // Weekdays: "friday", "this friday", "next friday", "friday next week".
  m = t.match(/^(this |next |coming |this coming )?([a-z]+)( next week| this week)?$/);
  if (m && own(WEEKDAY_ALIASES, m[2])) {
    const wd = WEEKDAY_ALIASES[m[2]];
    const prefix = (m[1] ?? "").trim();
    const suffix = (m[3] ?? "").trim();
    const soonest = upcoming(today, wd);
    const sameWeek = daysBetween(startOfWeek(today), soonest) < 7;

    if (suffix === "next week") return result(addDays(startOfWeek(today), 7 + ((wd + 6) % 7)), true);
    if (suffix === "this week") return result(addDays(startOfWeek(today), (wd + 6) % 7), true);
    if (prefix === "next") {
      // "Next Friday" said on a Tuesday could mean this week's or next week's.
      if (sameWeek) return result(addDays(soonest, 7), false, [soonest]);
      return result(soonest, true);
    }
    // "Friday" / "this Friday" said on a Friday: today, but ask.
    if (daysBetween(today, soonest) === 0) return result(today, false, [addDays(today, 7)]);
    return result(soonest, true);
  }

  // ISO: 2026-10-20
  m = t.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (m) return result(validDate(+m[1], +m[2] - 1, +m[3]), true);

  // Month name: "oct 20", "october 20 2026", "20 oct", "20 of october"
  m = t.match(/^([a-z]+) (\d{1,2})(?: (\d{4}))?$/) ?? null;
  let monthName: string | undefined, dayStr: string | undefined, yearStr: string | undefined;
  if (m && own(MONTHS, m[1])) [, monthName, dayStr, yearStr] = m;
  else {
    m = t.match(/^(\d{1,2})(?: of)? ([a-z]+)(?: (\d{4}))?$/);
    if (m && own(MONTHS, m[2])) [, dayStr, monthName, yearStr] = m;
  }
  if (monthName && dayStr) {
    return fromParts(today, yearStr ? +yearStr : null, MONTHS[monthName], +dayStr);
  }

  // Numeric: 10/20, 10/20/26, 20.10.2026
  m = t.match(/^(\d{1,2})[/.-](\d{1,2})(?:[/.-](\d{2}|\d{4}))?$/);
  if (m) {
    const a = +m[1];
    const b = +m[2];
    const year = m[3] ? (m[3].length === 2 ? 2000 + +m[3] : +m[3]) : null;
    const [month, day] = order === "MDY" ? [a, b] : [b, a];
    const primary = fromParts(today, year, month - 1, day);
    const other = fromParts(today, year, day - 1, month);
    if (a !== b && a <= 12 && b <= 12) {
      // 3/4 is genuinely ambiguous: keep the locale reading, offer the other.
      return { date: primary.date, alternatives: other.date ? [other.date] : [], confident: false };
    }
    // 20/10 has only one valid reading whatever the locale says.
    return primary.date ? primary : other;
  }

  // Vague or unknown ("soon", "asap", "later"): no date, ask.
  return result(null, false);
}

/** A month/day with optional year; without a year, a past day rolls forward. */
function fromParts(today: Date, year: number | null, month: number, day: number): DateResolution {
  if (year !== null) return result(validDate(year, month, day), true);
  let d = validDate(today.getFullYear(), month, day);
  if (d && daysBetween(today, d) < 0) d = validDate(today.getFullYear() + 1, month, day);
  return result(d, true);
}

/**
 * Combine the model's output with deterministic resolution and decide whether
 * the panel must ask the user before saving.
 */
export function resolveExtraction(
  dateText: string | null,
  modelConfidence: ModelConfidence,
  reference: Date,
  order: DayOrder = "MDY",
): DateResolution & { mustAsk: boolean } {
  if (!dateText || modelConfidence === "none") {
    return { date: null, alternatives: [], confident: false, mustAsk: true };
  }
  const r = resolveDatePhrase(dateText, reference, order);
  const confident = r.confident && modelConfidence === "high";
  return { ...r, confident, mustAsk: !confident };
}

/** Human label relative to today: "Today", "Tomorrow", "Friday", "Mon, Oct 26". */
export function relativeLabel(iso: string, reference: Date, locale?: string): string {
  const d = parseISODate(iso);
  const diff = daysBetween(reference, d);
  if (diff === 0) return "Today";
  if (diff === 1) return "Tomorrow";
  if (diff === -1) return "Yesterday";
  if (diff > 1 && diff < 7) return capitalize(WEEKDAYS[d.getDay()]);
  const opts: Intl.DateTimeFormatOptions = { weekday: "short", month: "short", day: "numeric" };
  if (d.getFullYear() !== reference.getFullYear()) opts.year = "numeric";
  return d.toLocaleDateString(locale, opts);
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** Guess the user's day order from their locale. */
export function dayOrderForLocale(locale: string): DayOrder {
  const parts = new Intl.DateTimeFormat(locale, { year: "numeric", month: "2-digit", day: "2-digit" })
    .formatToParts(new Date(2026, 10, 22))
    .filter((p) => p.type === "day" || p.type === "month")
    .map((p) => p.type);
  return parts[0] === "day" ? "DMY" : "MDY";
}
