/**
 * The trend SOURCE seam (issue #743). A {@link TrendSource} is the single injected dependency the service reads
 * raw trends from — the boundary that keeps the whole module offline-testable and lets a live integration drop
 * in later without touching the ranking core or store.
 *
 * Three implementations ship here:
 *   - {@link FixtureTrendSource}  — a DETERMINISTIC in-repo catalog. This is what the service serves while the
 *                                   feature is disabled (the default) and the fallback when a live source
 *                                   errors. It makes ZERO network calls, so the module ships dark and safe.
 *   - {@link EmptyTrendSource}    — yields nothing. The honest production placeholder until a real live source
 *                                   is wired (an unconfigured deployment returns an empty list, never fabricated
 *                                   data — #200 §3).
 *   - {@link StaticTrendSource}   — a test/demo double over a caller-supplied array.
 *
 * A source's output is UNTRUSTED web-derived DATA (#200 §6): the ranking core re-derives the score locally and
 * coerces the format, so nothing a source claims is taken on faith.
 */

import type { RawTrend } from "./types.js";

/** Where the service reads raw trends from. `fetch` is niche-scoped and must never throw for "no results". */
export interface TrendSource {
  /** Stable identifier for logging/attribution (e.g. `"fixture"`, `"empty"`). */
  readonly id: string;
  /** Whether this source reaches a live/network backend. The fixture/empty doubles are `false`. */
  readonly live: boolean;
  /** Read raw trends for a niche. Returns `[]` (never throws) when the niche has no trends. */
  fetch(input: { niche: string }): Promise<RawTrend[]>;
}

/**
 * The deterministic fixture catalog. Covers a handful of common niches; `fetch` returns the entries whose niche
 * matches (case/whitespace-insensitive), so an unknown niche yields `[]`. Signals are hand-set so the ranked
 * order is stable and assertable in tests. Never makes a network call.
 */
export const TREND_FIXTURES: readonly RawTrend[] = [
  {
    hook: "I tried the 5am cold plunge for 30 days — here's what nobody tells you",
    format: "short",
    niche: "fitness",
    sourceRef: "fixture:fitness:cold-plunge-30d",
    signals: { popularity: 0.92, recencyDays: 2, relevance: 0.95 },
  },
  {
    hook: "The one mobility drill that fixed my squat depth",
    format: "reel",
    niche: "fitness",
    sourceRef: "fixture:fitness:mobility-squat",
    signals: { popularity: 0.74, recencyDays: 6, relevance: 0.88 },
  },
  {
    hook: "Why your 'fat-burning zone' is a myth (and what to do instead)",
    format: "long",
    niche: "fitness",
    sourceRef: "fixture:fitness:fat-burn-myth",
    signals: { popularity: 0.81, recencyDays: 20, relevance: 0.7 },
  },
  {
    hook: "Stop overpaying for SaaS — this open-source stack replaced 6 tools",
    format: "short",
    niche: "saas",
    sourceRef: "fixture:saas:oss-stack",
    signals: { popularity: 0.88, recencyDays: 4, relevance: 0.9 },
  },
  {
    hook: "The pricing page change that doubled our trial conversions",
    format: "carousel",
    niche: "saas",
    sourceRef: "fixture:saas:pricing-page",
    signals: { popularity: 0.69, recencyDays: 9, relevance: 0.85 },
  },
  {
    hook: "I read 100 cold emails so you don't have to — the 3 that got replies",
    format: "story",
    niche: "saas",
    sourceRef: "fixture:saas:cold-email-teardown",
    signals: { popularity: 0.6, recencyDays: 30, relevance: 0.78 },
  },
];

/** The conservative production default while disabled / as a fallback: a deterministic offline catalog. */
export class FixtureTrendSource implements TrendSource {
  readonly id = "fixture";
  readonly live = false;
  constructor(private readonly catalog: readonly RawTrend[] = TREND_FIXTURES) {}

  async fetch(input: { niche: string }): Promise<RawTrend[]> {
    const want = input.niche.trim().replace(/\s+/g, " ").toLowerCase();
    if (want.length === 0) return [];
    return this.catalog
      .filter((t) => t.niche.trim().replace(/\s+/g, " ").toLowerCase() === want)
      .map((t) => ({ ...t, signals: { ...t.signals } }));
  }
}

/** The honest placeholder for an unwired live integration: yields nothing rather than fabricating data. */
export class EmptyTrendSource implements TrendSource {
  readonly id = "empty";
  readonly live = false;
  async fetch(): Promise<RawTrend[]> {
    return [];
  }
}

/** A test/demo double over a caller-supplied array. Optionally throws to exercise the fallback path. */
export class StaticTrendSource implements TrendSource {
  readonly id: string;
  readonly live = true;
  constructor(
    private readonly trends: readonly RawTrend[],
    private readonly opts: { id?: string; throwOnFetch?: boolean } = {},
  ) {
    this.id = opts.id ?? "static";
  }

  async fetch(input: { niche: string }): Promise<RawTrend[]> {
    if (this.opts.throwOnFetch) throw new Error("StaticTrendSource: simulated source failure");
    const want = input.niche.trim().replace(/\s+/g, " ").toLowerCase();
    return this.trends
      .filter((t) => t.niche.trim().replace(/\s+/g, " ").toLowerCase() === want)
      .map((t) => ({ ...t, signals: { ...t.signals } }));
  }
}
