/**
 * Unit tests for the trend-ingestion source (issue #743). These pin the contract the video agent (#740) and
 * the self-managed store rely on, with NO database and NO network (the injected source seam + in-memory store):
 *
 *   - ranking ORDER: records come back sorted by score desc, with deterministic structural tiebreaks;
 *   - DEDUPE: the pure core collapses (hook+format) duplicates, and the store collapses (workspace, niche,
 *     dedupeKey) duplicates / updates in place on re-ingest;
 *   - EMPTY niche: short-circuits to an empty result with no source call and no writes;
 *   - provider FALLBACK: disabled ⇒ fixture (no network); enabled-but-erroring live source ⇒ fixture fallback.
 */

import { describe, it, expect } from "vitest";
import {
  rankTrends,
  scoreSignals,
  coerceFormat,
  dedupeKey,
  resolveTrendCaps,
  TREND_DEFAULTS,
  InMemoryTrendStore,
  TrendService,
  toVideoBriefs,
  FixtureTrendSource,
  EmptyTrendSource,
  StaticTrendSource,
  type RawTrend,
  type TrendCaps,
} from "../../src/trends/index.js";

const CAPS: TrendCaps = TREND_DEFAULTS;

function raw(over: Partial<RawTrend> & Pick<RawTrend, "hook">): RawTrend {
  return {
    hook: over.hook,
    format: over.format ?? "short",
    niche: over.niche ?? "fitness",
    sourceRef: over.sourceRef ?? `src:${over.hook}`,
    signals: over.signals ?? { popularity: 0.5, recencyDays: 1, relevance: 0.5 },
  };
}

describe("rankTrends — ordering", () => {
  it("returns records sorted by score descending", () => {
    const raws: RawTrend[] = [
      raw({ hook: "mid", signals: { popularity: 0.5, recencyDays: 1, relevance: 0.5 } }),
      raw({ hook: "top", signals: { popularity: 1, recencyDays: 0, relevance: 1 } }),
      raw({ hook: "low", signals: { popularity: 0.1, recencyDays: 60, relevance: 0.1 } }),
    ];
    const ranked = rankTrends(raws, "fitness", CAPS);
    expect(ranked.map((r) => r.hook)).toEqual(["top", "mid", "low"]);
    expect(ranked[0]!.score).toBeGreaterThan(ranked[1]!.score);
    expect(ranked[1]!.score).toBeGreaterThan(ranked[2]!.score);
  });

  it("breaks score ties deterministically by hook then sourceRef", () => {
    const sig = { popularity: 0.6, recencyDays: 3, relevance: 0.6 };
    const raws: RawTrend[] = [
      raw({ hook: "bravo", sourceRef: "src:z", signals: sig }),
      raw({ hook: "alpha", sourceRef: "src:b", signals: sig }),
      raw({ hook: "alpha", sourceRef: "src:a", format: "reel", signals: sig }),
    ];
    const ranked = rankTrends(raws, "fitness", CAPS);
    // all equal score ⇒ hook asc, then sourceRef asc
    expect(ranked.map((r) => `${r.hook}|${r.sourceRef}`)).toEqual([
      "alpha|src:a",
      "alpha|src:b",
      "bravo|src:z",
    ]);
  });

  it("produces a 0–100 integer score and normalizes the niche to canonical form", () => {
    const ranked = rankTrends([raw({ hook: "h", niche: "  FIT  ness " })], "Fit Ness", CAPS);
    expect(ranked).toHaveLength(1);
    expect(ranked[0]!.score).toBeGreaterThanOrEqual(0);
    expect(ranked[0]!.score).toBeLessThanOrEqual(100);
    expect(Number.isInteger(ranked[0]!.score)).toBe(true);
    expect(ranked[0]!.niche).toBe("fit ness");
  });

  it("respects the maxResults cap", () => {
    const raws = Array.from({ length: 5 }, (_, i) =>
      raw({ hook: `h${i}`, signals: { popularity: i / 5, recencyDays: 1, relevance: 0.5 } }),
    );
    const ranked = rankTrends(raws, "fitness", { ...CAPS, maxResults: 2 });
    expect(ranked).toHaveLength(2);
  });
});

describe("rankTrends — dedupe", () => {
  it("collapses duplicate (hook+format) keeping the highest score", () => {
    const raws: RawTrend[] = [
      raw({ hook: "Same Hook", sourceRef: "src:weak", signals: { popularity: 0.2, recencyDays: 30, relevance: 0.2 } }),
      raw({ hook: "  same   hook ", sourceRef: "src:strong", signals: { popularity: 1, recencyDays: 0, relevance: 1 } }),
    ];
    const ranked = rankTrends(raws, "fitness", CAPS);
    expect(ranked).toHaveLength(1);
    expect(ranked[0]!.sourceRef).toBe("src:strong");
  });

  it("keeps different formats of the same hook as distinct records", () => {
    const raws: RawTrend[] = [
      raw({ hook: "do this", format: "short" }),
      raw({ hook: "do this", format: "reel" }),
    ];
    const ranked = rankTrends(raws, "fitness", CAPS);
    expect(ranked).toHaveLength(2);
  });
});

describe("rankTrends — empty niche", () => {
  it("returns [] for empty / whitespace niche", () => {
    expect(rankTrends([raw({ hook: "h" })], "", CAPS)).toEqual([]);
    expect(rankTrends([raw({ hook: "h" })], "   ", CAPS)).toEqual([]);
  });

  it("returns [] when no trend matches the requested niche", () => {
    expect(rankTrends([raw({ hook: "h", niche: "fitness" })], "saas", CAPS)).toEqual([]);
  });
});

describe("pure helpers", () => {
  it("coerceFormat coerces unknown formats to 'short'", () => {
    expect(coerceFormat("REEL")).toBe("reel");
    expect(coerceFormat("tiktok-dance")).toBe("short");
  });

  it("scoreSignals rewards popularity, recency, and relevance and clamps to 0–100", () => {
    const best = scoreSignals({ popularity: 1, recencyDays: 0, relevance: 1 }, CAPS);
    const worst = scoreSignals({ popularity: 0, recencyDays: 9999, relevance: 0 }, CAPS);
    const overdriven = scoreSignals({ popularity: 5, recencyDays: -10, relevance: 5 }, CAPS);
    expect(best).toBe(100);
    expect(worst).toBe(0);
    expect(overdriven).toBeLessThanOrEqual(100);
  });

  it("dedupeKey normalizes hook whitespace/case but keeps format", () => {
    expect(dedupeKey("  Hello  World ", "short")).toBe(dedupeKey("hello world", "short"));
    expect(dedupeKey("x", "short")).not.toBe(dedupeKey("x", "reel"));
  });
});

describe("resolveTrendCaps", () => {
  it("defaults to DISABLED with normalized weights", () => {
    const caps = resolveTrendCaps({});
    expect(caps.enabled).toBe(false);
    const sum = caps.weightPopularity + caps.weightRecency + caps.weightRelevance;
    expect(sum).toBeCloseTo(1, 6);
  });

  it("enables only on explicit truthy tokens", () => {
    expect(resolveTrendCaps({ TRENDS_ENABLED: "1" }).enabled).toBe(true);
    expect(resolveTrendCaps({ TRENDS_ENABLED: "true" }).enabled).toBe(true);
    expect(resolveTrendCaps({ TRENDS_ENABLED: "0" }).enabled).toBe(false);
    expect(resolveTrendCaps({ TRENDS_ENABLED: "nope" }).enabled).toBe(false);
  });

  it("falls back to safe defaults when all weights are zero", () => {
    const caps = resolveTrendCaps({
      TRENDS_WEIGHT_POPULARITY: "0",
      TRENDS_WEIGHT_RECENCY: "0",
      TRENDS_WEIGHT_RELEVANCE: "0",
    });
    expect(caps.weightPopularity).toBeCloseTo(TREND_DEFAULTS.weightPopularity, 6);
  });
});

describe("FixtureTrendSource", () => {
  it("returns deterministic catalog entries for a known niche and nothing for unknown", async () => {
    const src = new FixtureTrendSource();
    const fitness = await src.fetch({ niche: "fitness" });
    expect(fitness.length).toBeGreaterThan(0);
    expect(fitness.every((t) => t.niche === "fitness")).toBe(true);
    expect(await src.fetch({ niche: "underwater-basket-weaving" })).toEqual([]);
    expect(await src.fetch({ niche: "" })).toEqual([]);
  });
});

describe("TrendService — default OFF + provider fallback", () => {
  it("serves the fixture (no live source) while disabled", async () => {
    const liveCalls: string[] = [];
    const live = new StaticTrendSource([raw({ hook: "LIVE ONLY", niche: "fitness" })], { id: "live" });
    // wrap to detect any call
    const spyLive: typeof live = Object.assign(Object.create(Object.getPrototypeOf(live)), live, {
      fetch: async (input: { niche: string }) => {
        liveCalls.push(input.niche);
        return live.fetch(input);
      },
    });
    const svc = new TrendService({
      store: new InMemoryTrendStore(),
      source: spyLive,
      fallback: new FixtureTrendSource(),
      caps: { ...TREND_DEFAULTS, enabled: false },
    });
    const res = await svc.ingest("ws1", "fitness");
    expect(res.servedBy).toBe("fixture-disabled");
    expect(res.sourceId).toBe("fixture");
    expect(liveCalls).toEqual([]); // live source NEVER touched while disabled
    expect(res.records.length).toBeGreaterThan(0);
    expect(res.records.every((r) => !r.sourceRef.includes("LIVE ONLY"))).toBe(true);
  });

  it("uses the live source when enabled", async () => {
    const live = new StaticTrendSource(
      [raw({ hook: "live trend", niche: "fitness", signals: { popularity: 1, recencyDays: 0, relevance: 1 } })],
      { id: "live" },
    );
    const svc = new TrendService({
      store: new InMemoryTrendStore(),
      source: live,
      fallback: new FixtureTrendSource(),
      caps: { ...TREND_DEFAULTS, enabled: true },
    });
    const res = await svc.ingest("ws1", "fitness");
    expect(res.servedBy).toBe("live");
    expect(res.sourceId).toBe("live");
    expect(res.records.map((r) => r.hook)).toContain("live trend");
  });

  it("falls back to the fixture when the enabled live source throws", async () => {
    const broken = new StaticTrendSource([], { id: "live", throwOnFetch: true });
    const svc = new TrendService({
      store: new InMemoryTrendStore(),
      source: broken,
      fallback: new FixtureTrendSource(),
      caps: { ...TREND_DEFAULTS, enabled: true },
    });
    const res = await svc.ingest("ws1", "fitness");
    expect(res.servedBy).toBe("fixture-fallback");
    expect(res.sourceId).toBe("fixture");
    expect(res.records.length).toBeGreaterThan(0);
  });

  it("an enabled-but-empty live source returns an honest empty list (no fabrication)", async () => {
    const svc = new TrendService({
      store: new InMemoryTrendStore(),
      source: new EmptyTrendSource(),
      fallback: new FixtureTrendSource(),
      caps: { ...TREND_DEFAULTS, enabled: true },
    });
    const res = await svc.ingest("ws1", "fitness");
    expect(res.servedBy).toBe("live");
    expect(res.records).toEqual([]);
  });
});

describe("TrendService — empty niche", () => {
  it("short-circuits with no source call and no writes", async () => {
    const store = new InMemoryTrendStore();
    let fetched = 0;
    const counting = new StaticTrendSource([raw({ hook: "x" })], { id: "live" });
    const spy: typeof counting = Object.assign(Object.create(Object.getPrototypeOf(counting)), counting, {
      fetch: async (input: { niche: string }) => {
        fetched++;
        return counting.fetch(input);
      },
    });
    const svc = new TrendService({ store, fallback: spy, source: spy, caps: { ...TREND_DEFAULTS } });
    const res = await svc.ingest("ws1", "   ");
    expect(res.records).toEqual([]);
    expect(res.stored).toEqual([]);
    expect(fetched).toBe(0);
    expect(await store.listByNiche("ws1", "fitness")).toEqual([]);
  });
});

describe("TrendService — store dedupe + persistence", () => {
  it("persists the ranked list and updates in place on re-ingest (no duplicate rows)", async () => {
    const store = new InMemoryTrendStore();
    const svc = new TrendService({
      store,
      fallback: new FixtureTrendSource(),
      caps: { ...TREND_DEFAULTS, enabled: false },
    });
    const first = await svc.ingest("ws1", "saas");
    const countFirst = (await store.listByNiche("ws1", "saas")).length;
    expect(first.stored.length).toBe(countFirst);
    expect(countFirst).toBeGreaterThan(0);

    // Re-ingest the same niche: same dedupe keys ⇒ rows updated, not duplicated.
    await svc.ingest("ws1", "saas");
    const countSecond = (await store.listByNiche("ws1", "saas")).length;
    expect(countSecond).toBe(countFirst);
  });

  it("scopes reads per workspace (IDOR boundary)", async () => {
    const store = new InMemoryTrendStore();
    const svc = new TrendService({ store, fallback: new FixtureTrendSource(), caps: { ...TREND_DEFAULTS } });
    await svc.ingest("ws1", "saas");
    expect(await store.listByNiche("ws2", "saas")).toEqual([]);
  });
});

describe("toVideoBriefs — video agent (#740) consumption", () => {
  it("strips ranked records to {hook, format, niche, sourceRef} preserving order", () => {
    const ranked = rankTrends(
      [
        raw({ hook: "b", signals: { popularity: 0.4, recencyDays: 1, relevance: 0.4 } }),
        raw({ hook: "a", signals: { popularity: 1, recencyDays: 0, relevance: 1 } }),
      ],
      "fitness",
      CAPS,
    );
    const briefs = toVideoBriefs(ranked);
    expect(briefs).toEqual(
      ranked.map((r) => ({ hook: r.hook, format: r.format, niche: r.niche, sourceRef: r.sourceRef })),
    );
    expect(briefs[0]!.hook).toBe("a"); // highest score first, order preserved
    expect(Object.keys(briefs[0]!).sort()).toEqual(["format", "hook", "niche", "sourceRef"]);
  });
});
