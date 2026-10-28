import type { Task } from "./types";

const TAG = /(#[\p{L}\p{N}_-]+)/u;
const TAG_GLOBAL = /#[\p{L}\p{N}_-]+/gu;

/** `#tags` in a title, lowercased, without duplicates. */
export function tagsOf(title: string): string[] {
  return [...new Set((title.match(TAG_GLOBAL) ?? []).map((t) => t.toLowerCase()))];
}

/** Split a title into plain text and tag parts, for rendering. */
export function titleParts(title: string): { text: string; tag: boolean }[] {
  return title
    .split(TAG)
    .filter((p) => p !== "")
    .map((p) => ({ text: p, tag: TAG.test(p) && p.startsWith("#") }));
}

/** The most used tags across open tasks, most frequent first. */
export function topTags(tasks: Task[], max = 8): string[] {
  const counts = new Map<string, number>();
  for (const t of tasks) {
    if (t.done) continue;
    for (const tag of tagsOf(t.title)) counts.set(tag, (counts.get(tag) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, max)
    .map(([tag]) => tag);
}

/**
 * Does a task match a search? Every word must appear in the title, the
 * original text or the source app; `#tag` words must be tags of the task.
 */
export function matchesQuery(task: Task, query: string): boolean {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return true;
  const tags = tagsOf(task.title);
  const hay = [task.title, task.notes ?? "", task.source_text ?? "", task.source_app ?? ""].join(" ").toLowerCase();
  return words.every((w) => (w.startsWith("#") && w.length > 1 ? tags.includes(w) : hay.includes(w)));
}

const LINK = /((?:https?:\/\/|mailto:)[^\s<>"']+[^\s<>"'.,;:!?)\]])/i;

/** Split a description into text and link parts, for rendering. */
export function linkParts(text: string): { text: string; url: string | null }[] {
  return text
    .split(LINK)
    .filter((p) => p !== "")
    .map((p) => ({ text: p, url: /^(https?:\/\/|mailto:)/i.test(p) ? p : null }));
}

/** "Slack", or the site name for a web link with no app ("github.com"). */
export function sourceLabel(task: Pick<Task, "source_app" | "source_url">): string | null {
  if (task.source_url) {
    try {
      const u = new URL(task.source_url);
      if (u.protocol === "file:") {
        const name = decodeURIComponent(u.pathname.split("/").pop() ?? "");
        return name || task.source_app;
      }
      const host = u.hostname.replace(/^www\./, "");
      // Browsers: the site says more than "Google Chrome".
      if (!task.source_app || /chrome|safari|firefox|edge|brave|arc|opera|vivaldi/i.test(task.source_app)) {
        return host;
      }
    } catch {
      // Not a URL; fall through to the app name.
    }
  }
  return task.source_app;
}

/** Priority names, by number (1 is the most urgent). */
export const PRIORITIES: { n: 1 | 2 | 3; label: string; name: string; color: string }[] = [
  { n: 1, label: "P1", name: "Urgent", color: "#ef5b4f" },
  { n: 2, label: "P2", name: "High", color: "#f0a03c" },
  { n: 3, label: "P3", name: "Medium", color: "#5b9cf5" },
];

export function priorityColor(p: number | undefined | null): string | null {
  return PRIORITIES.find((x) => x.n === p)?.color ?? null;
}

const PRIORITY_WORD = /(^|\s)p([1-3])(?=\s|$)/i;

/** "call the bank p1" → priority 1 and "call the bank". The last one typed wins. */
export function takePriority(title: string): { priority: number | null; rest: string; matched: string | null } {
  let priority: number | null = null;
  let matched: string | null = null;
  let rest = title;
  for (;;) {
    const m = PRIORITY_WORD.exec(rest);
    if (!m) break;
    priority = Number(m[2]);
    matched = `p${m[2]}`;
    rest = (rest.slice(0, m.index) + rest.slice(m.index + m[0].length)).replace(/\s+/g, " ");
  }
  return { priority, rest: priority ? rest.trim() : title, matched };
}

/** Add or remove `#tag` in a title. */
export function toggleTag(title: string, tag: string): string {
  const t = tag.startsWith("#") ? tag : `#${tag}`;
  const has = tagsOf(title).includes(t.toLowerCase());
  if (has) {
    const re = new RegExp(`(^|\\s)${t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?=\\s|$)`, "iu");
    return title.replace(re, "").replace(/\s+/g, " ").trim();
  }
  return `${title.trim()} ${t}`.trim();
}
