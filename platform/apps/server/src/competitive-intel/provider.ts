/**
 * The competitor-intelligence SOURCE seam for issue #619. A `CompetitorIntelSource` observes one competitor's
 * current pricing / messaging / launches. Real sources (a scraper, a pricing-page watcher, a news API) live
 * behind this one interface so the service, the diff core, and every test never touch the network.
 *
 * Honoring the premortem (#200 §3 production-grounded): the DEFAULT source is the deterministic, offline
 * {@link FakeCompetitorIntelSource}. It makes NO external call and returns the SAME snapshot for the same
 * competitor every time, so an unwired/disabled deployment produces stable, clearly-synthetic data and never
 * reports a spurious "change". A real source is a deliberate, owner-gated follow-up injected into the service,
 * never baked into the default path.
 */

import type { CompetitorRef, CompetitorSnapshot, Launch, PricingTier } from "./types.js";

export interface CompetitorIntelSource {
  /** Provider kind (`fake` | `empty` | `static` | a real adapter's name). */
  readonly kind: string;
  /** Whether this source observes REAL competitor data. Read paths surface this so the offer stays honest. */
  readonly live: boolean;
  /** Observe the competitor's current public state. Throws on an unrecoverable fetch error. */
  fetchSnapshot(competitor: CompetitorRef): Promise<CompetitorSnapshot>;
}

/** A small error so a route can map a source failure to a friendly response instead of a 500. */
export class CompetitorIntelSourceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CompetitorIntelSourceError";
  }
}

/** Deterministic 32-bit FNV-1a hash of a seed — no clock, no randomness. */
function fnv1a(seed: string): number {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** Pick a stable element of `arr` from a seed. */
function pick<T>(arr: readonly T[], seed: string): T {
  // arr is always non-empty at call sites below; guard keeps noUncheckedIndexedAccess happy.
  const idx = fnv1a(seed) % arr.length;
  return arr[idx] as T;
}

const TIER_NAMES = ["Starter", "Growth", "Enterprise"] as const;
const TAGLINES = [
  "The fastest way to ship",
  "Marketing on autopilot",
  "Built for modern teams",
  "Your growth, automated",
] as const;
const VALUE_PROPS = [
  "No-code automation",
  "Best-in-class analytics",
  "24/7 support",
  "SOC 2 compliant",
  "Unlimited seats",
  "AI-assisted workflows",
] as const;
const LAUNCH_TITLES = [
  "AI Assistant GA",
  "New Analytics Suite",
  "Enterprise SSO",
  "Mobile App v2",
] as const;

/**
 * The default offline source. Derives a plausible, fully deterministic snapshot from the competitor id, so
 * the demo/disabled path works with zero configuration and zero network egress, and repeat calls never
 * manufacture a fake "change". `live` is false so every read path tells the honest truth.
 */
export class FakeCompetitorIntelSource implements CompetitorIntelSource {
  readonly kind = "fake";
  readonly live = false;

  async fetchSnapshot(competitor: CompetitorRef): Promise<CompetitorSnapshot> {
    const base = competitor.homepageUrl ?? `https://example.com/${competitor.id}`;
    const root = base.replace(/\/+$/, "");
    const h = fnv1a(competitor.id);

    const pricing: PricingTier[] = TIER_NAMES.map((name, i) => {
      const cadence = name === "Enterprise" ? ("custom" as const) : ("monthly" as const);
      const priceUsd = name === "Enterprise" ? null : 10 + ((h >> (i * 4)) % 10) * 10 + i * 50;
      return { name, priceUsd, cadence, sourceUrl: `${root}/pricing` };
    });

    const propCount = 2 + (h % 2); // 2 or 3 value props, deterministically
    const valueProps: string[] = [];
    for (let i = 0; i < propCount; i++) {
      const p = pick(VALUE_PROPS, `${competitor.id}:prop:${i}`);
      if (!valueProps.includes(p)) valueProps.push(p);
    }

    const launchCount = 1 + (h % 2); // 1 or 2 launches
    const launches: Launch[] = [];
    for (let i = 0; i < launchCount; i++) {
      const title = pick(LAUNCH_TITLES, `${competitor.id}:launch:${i}`);
      // Stable, synthetic announcement dates (no wall-clock read keeps this deterministic).
      const day = 1 + ((h >> (i * 3)) % 28);
      const date = `2026-0${1 + (i % 3)}-${day < 10 ? `0${day}` : day}`;
      launches.push({
        id: `${competitor.id}-launch-${i}`,
        title,
        date,
        sourceUrl: `${root}/blog`,
      });
    }

    return {
      competitor,
      pricing,
      messaging: {
        tagline: pick(TAGLINES, competitor.id),
        valueProps,
        sourceUrl: root,
      },
      launches,
    };
  }
}

/**
 * An honest empty source — observes nothing. Useful as a placeholder before a real adapter is wired, and to
 * assert the "no data ⇒ empty digest" path.
 */
export class EmptyCompetitorIntelSource implements CompetitorIntelSource {
  readonly kind = "empty";
  readonly live = false;

  async fetchSnapshot(competitor: CompetitorRef): Promise<CompetitorSnapshot> {
    return {
      competitor,
      pricing: [],
      messaging: { tagline: "", valueProps: [], sourceUrl: competitor.homepageUrl ?? null },
      launches: [],
    };
  }
}

/**
 * A test/demo double that serves caller-supplied snapshots keyed by competitor id, modeling a `live` source.
 * `throwOnFetch` makes `fetchSnapshot` reject so the service's fall-back-to-fake contract is exercisable.
 */
export class StaticCompetitorIntelSource implements CompetitorIntelSource {
  readonly kind = "static";
  readonly live = true;
  private readonly snapshots: Map<string, CompetitorSnapshot>;
  private readonly throwOnFetch: boolean;

  constructor(opts: { snapshots?: CompetitorSnapshot[]; throwOnFetch?: boolean } = {}) {
    this.snapshots = new Map((opts.snapshots ?? []).map((s) => [s.competitor.id, s]));
    this.throwOnFetch = opts.throwOnFetch ?? false;
  }

  async fetchSnapshot(competitor: CompetitorRef): Promise<CompetitorSnapshot> {
    if (this.throwOnFetch) {
      throw new CompetitorIntelSourceError(`static source failed for "${competitor.id}"`);
    }
    const snap = this.snapshots.get(competitor.id);
    if (snap) return snap;
    return {
      competitor,
      pricing: [],
      messaging: { tagline: "", valueProps: [], sourceUrl: competitor.homepageUrl ?? null },
      launches: [],
    };
  }
}
