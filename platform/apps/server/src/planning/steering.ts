import type { BacklogItemRecord } from "./types.js";

export type SteeringTimeframe = "this_week" | "ongoing";

export interface PlanningSteeringDirective {
  intent: string;
  keywords: string[];
  timeframe: SteeringTimeframe;
}

const STOP_WORDS = new Set([
  "a",
  "an",
  "and",
  "for",
  "in",
  "on",
  "the",
  "this",
  "to",
  "week",
  "with",
]);

const PHRASE_MARKERS = ["focus on", "prioritize", "steer toward", "aim at", "work on"] as const;

function words(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/\s+/)
    .map((w) => w.trim())
    .filter((w) => w.length > 2 && !STOP_WORDS.has(w));
}

function singular(word: string): string {
  return word.endsWith("s") && word.length > 4 ? word.slice(0, -1) : word;
}

export function parseSteeringIntent(intent: string): PlanningSteeringDirective {
  const trimmed = intent.trim();
  const lower = trimmed.toLowerCase();
  let focus = lower;
  for (const marker of PHRASE_MARKERS) {
    const idx = lower.indexOf(marker);
    if (idx !== -1) {
      focus = lower.slice(idx + marker.length);
      break;
    }
  }
  focus = focus.replace(/\b(this|next)\s+week\b/g, " ");
  const keywords = Array.from(new Set(words(focus).map(singular)));
  return {
    intent: trimmed,
    keywords,
    timeframe: /\b(this|next)\s+week\b/.test(lower) ? "this_week" : "ongoing",
  };
}

export function steeringMatchScore(item: BacklogItemRecord, directive?: PlanningSteeringDirective | null): number {
  if (!directive || directive.keywords.length === 0) return 0;
  const text = words(`${item.title} ${item.description} ${item.sourceRef}`).map(singular);
  const haystack = new Set(text);
  return directive.keywords.reduce((score, keyword) => score + (haystack.has(keyword) ? 1 : 0), 0);
}
