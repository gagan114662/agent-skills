/**
 * SEO rank tracking (#294) — the pure type + constant vocabulary the rank-tracking loop shares (no IO).
 *
 * The point of this feature, set by the #200 premortem §2: a ranking is only believable if it comes from
 * an EXTERNAL source (a rank-tracking API, Google Search Console), recorded as a receipt with the
 * provider's own id — never a number ipop made up about itself. A `RankObservation` is exactly that
 * receipt: one (keyword, url, position) reading a real provider returned at a real time. The founder
 * console's SEO proof tile reads these rows and nothing else, so it can only ever show externally-grounded
 * rankings (or "not connected" when no provider has reported).
 *
 * INJECTION-QUARANTINE (premortem §6): a provider's response is untrusted DATA. The keyword and URL are
 * STRUCTURAL fields — they are stored and displayed, but they never become instructions and never trigger
 * a send or spend. `decideRankIngest` sanitises every field before it is persisted.
 */

/** The search engines a rank can be observed on. Closed enum so a provider can't inject an arbitrary key. */
export const SEARCH_ENGINES = ["google", "bing"] as const;
export type SearchEngine = (typeof SEARCH_ENGINES)[number];
export function isSearchEngine(value: string): value is SearchEngine {
  return (SEARCH_ENGINES as readonly string[]).includes(value);
}

/** The pluggable rank-data providers behind the {@link RankTrackingProvider} seam. `dryrun` reports nothing. */
export const RANK_PROVIDER_KINDS = ["dryrun", "search_console", "serpapi", "dataforseo"] as const;
export type RankProviderKind = (typeof RANK_PROVIDER_KINDS)[number];
export function isRankProviderKind(value: string): value is RankProviderKind {
  return (RANK_PROVIDER_KINDS as readonly string[]).includes(value);
}

/** First page = positions 1..10. The headline proof metric is "target keywords on page 1". */
export const PAGE_ONE_MAX_POSITION = 10;

/** Field-length bounds — a hostile provider response can never blow up a row. */
export const MAX_KEYWORD_LEN = 200;
export const MAX_URL_LEN = 2048;
export const MAX_EXTERNAL_ID_LEN = 200;

/**
 * One external rank reading — the receipt. `position` is null when the URL did not rank for the keyword in
 * the provider's window (an honest "not ranking", not a missing row). `externalId` is the provider's own
 * record id (the proof this came from outside). `observedAtMs` is when the provider measured it.
 */
export interface RankObservation {
  keyword: string;
  url: string;
  /** 1-based SERP position, or null = not ranking in the checked window. */
  position: number | null;
  searchEngine: SearchEngine;
  /** ISO-3166-ish lowercased country/market code the rank was checked in (e.g. "us"). */
  country: string;
  provider: RankProviderKind;
  externalId: string;
  observedAtMs: number;
  /** Untrusted provider extras (already sanitised to a flat string map by ingest). */
  detail: Record<string, string>;
}

/** A raw, untrusted row as a {@link RankTrackingProvider} returns it (before validation/sanitisation). */
export interface ProviderRankRow {
  keyword?: unknown;
  url?: unknown;
  position?: unknown;
  searchEngine?: unknown;
  country?: unknown;
  externalId?: unknown;
  observedAtMs?: unknown;
  detail?: unknown;
}

/**
 * Strip control characters and clamp length — keywords/URLs are structural data, never instructions.
 * Implemented via a codepoint check (not a control-char regex literal) so the source stays clean.
 */
export function sanitizeField(value: string, max: number): string {
  let out = "";
  for (const ch of value) {
    const code = ch.codePointAt(0) ?? 0;
    out += code < 0x20 || code === 0x7f ? " " : ch;
  }
  return out.trim().slice(0, max);
}
