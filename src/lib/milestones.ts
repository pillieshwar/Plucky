/**
 * City milestones: the city grows with its population (every task you've
 * finished). Each milestone adds something to the skyline for good — the
 * highest population ever reached counts, so un-ticking a task never takes
 * anything away. Rewards are for the city only, never features of the app.
 */

export type UnlockId = "lamps" | "park" | "fountain" | "train" | "harbour" | "stadium" | "island";

export interface Milestone {
  id: UnlockId;
  /** Population (tasks finished) that unlocks it. */
  at: number;
  name: string;
  emoji: string;
  /** What appears in the city. */
  what: string;
  /** The celebration: "Population 100 — the train is running!" */
  cheer: string;
  /** A page for the city's Story. */
  story: string;
}

export const MILESTONES: Milestone[] = [
  {
    id: "lamps",
    at: 10,
    name: "Street lamps",
    emoji: "🏮",
    what: "Lamps light every street corner.",
    cheer: "the street lamps are on!",
    story: "Ten people live here now, so the council put up street lamps. Every corner glows at night — no one walks home in the dark.",
  },
  {
    id: "park",
    at: 25,
    name: "A park",
    emoji: "🌳",
    what: "A green park with trees opens at the south end of town.",
    cheer: "a park just opened!",
    story: "Twenty-five residents asked for somewhere green. A park opened at the south end of town, with paths and trees to sit under.",
  },
  {
    id: "fountain",
    at: 50,
    name: "The fountain",
    emoji: "⛲",
    what: "A fountain in the middle of the park — the town square.",
    cheer: "the fountain is flowing!",
    story: "Fifty people, one meeting place. A fountain now flows in the middle of the park: the town square, where everyone bumps into each other.",
  },
  {
    id: "train",
    at: 100,
    name: "The train line",
    emoji: "🚆",
    what: "A train circles the whole city, day and night.",
    cheer: "the train is running!",
    story: "A hundred residents — a real city. A train line now loops around it, carriages lit, taking everyone where they need to go.",
  },
  {
    id: "harbour",
    at: 250,
    name: "The harbour",
    emoji: "⛵",
    what: "The east side opens onto the water: a pier, a lighthouse and boats.",
    cheer: "boats are in the harbour!",
    story: "Two hundred and fifty people. The city reached the sea: a harbour with a pier, a little lighthouse, and boats rocking at their moorings.",
  },
  {
    id: "stadium",
    at: 500,
    name: "The stadium",
    emoji: "🏟️",
    what: "A stadium with floodlights on the west side.",
    cheer: "the stadium lights are on!",
    story: "Five hundred residents fill a stadium. On match nights the floodlights on the west side can be seen from every window.",
  },
  {
    id: "island",
    at: 1000,
    name: "The island",
    emoji: "🌉",
    what: "A bridge across the harbour to a second island, with its own little skyline.",
    cheer: "a bridge reaches the island!",
    story: "A thousand people. The city outgrew its shore, so a bridge now crosses the harbour to a second island — and its first lights are on.",
  },
];

/** The rules, as shown to the user. */
export const MILESTONE_RULES: string[] = [
  "Your population is every task you've finished — each one is someone moving in.",
  "At each milestone the city gains something new: lamps, a park, a train, a harbour…",
  "What's built stays built. Un-ticking or deleting a task never takes anything away.",
  "No streaks, no points, nothing to lose. Rewards are for your city — every feature of the app is yours from day one.",
];

/** The milestones a population has reached, in order. */
export function reachedMilestones(population: number): Milestone[] {
  return MILESTONES.filter((m) => population >= m.at);
}

/** Whether something is built at this population. */
export function isUnlocked(id: UnlockId, population: number): boolean {
  const m = MILESTONES.find((x) => x.id === id);
  return !!m && population >= m.at;
}

/** The next milestone and how far along the way to it the city is (0–1). */
export function nextMilestone(population: number): { milestone: Milestone; left: number; progress: number } | null {
  const i = MILESTONES.findIndex((m) => population < m.at);
  if (i < 0) return null;
  const m = MILESTONES[i];
  const from = i === 0 ? 0 : MILESTONES[i - 1].at;
  return { milestone: m, left: m.at - population, progress: Math.max(0, Math.min(1, (population - from) / (m.at - from))) };
}

/** Milestones reached since the last one celebrated (`seen` is its population). */
export function newMilestones(seen: number, population: number): Milestone[] {
  return MILESTONES.filter((m) => m.at > seen && m.at <= population);
}

/** The celebration line for newly reached milestones (the highest one). */
export function cheerFor(fresh: Milestone[]): string | null {
  const top = fresh[fresh.length - 1];
  if (!top) return null;
  const more = fresh.length > 1 ? ` (${fresh.length} milestones reached)` : "";
  return `Population ${top.at.toLocaleString()} — ${top.cheer}${more}`;
}
