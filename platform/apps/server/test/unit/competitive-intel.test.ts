import { describe, it, expect } from "vitest";

import {
  buildDigest,
  CompetitiveIntelService,
  COMPETITIVE_INTEL_DEFAULTS,
  diffSnapshots,
  EmptyCompetitorIntelSource,
  FakeCompetitorIntelSource,
  InMemoryCompetitiveIntelStore,
  resolveCompetitiveIntelCaps,
  StaticCompetitorIntelSource,
  type CompetitiveIntelCaps,
  type CompetitorRef,
  type CompetitorSnapshot,
  type MaterialChange,
} from "../../src/competitive-intel/index.js";

// --- helpers ----------------------------------------------------------------------------------------

/** A monotonic, deterministic clock so digest timestamps are pinned in tests. */
function fixedClock(startMs = Date.parse("2026-06-22T00:00:00.000Z")) {
  let t = startMs;
  return () => new Date((t += 60_000));
}

const ACME: CompetitorRef = { id: "acme", name: "Acme", homepageUrl: "https://acme.test" };
const RIVAL: CompetitorRef = { id: "rival", name: "Rival Co", homepageUrl: "https://rival.test" };

function snapshot(over: Partial<CompetitorSnapshot> & { competitor?: CompetitorRef } = {}): CompetitorSnapshot {
  return {
    competitor: over.competitor ?? ACME,
    pricing: over.pricing ?? [
      { name: "Starter", priceUsd: 10, cadence: "monthly", sourceUrl: "https://acme.test/pricing" },
      { name: "Pro", priceUsd: 100, cadence: "monthly", sourceUrl: "https://acme.test/pricing" },
      { name: "Enterprise", priceUsd: null, cadence: "custom", sourceUrl: "https://acme.test/pricing" },
    ],
    messaging: over.messaging ?? {
      tagline: "Ship faster",
      valueProps: ["No-code", "Analytics"],
      sourceUrl: "https://acme.test",
    },
    launches: over.launches ?? [
      { id: "l1", title: "AI Assistant", date: "2026-05-01", sourceUrl: "https://acme.test/blog/ai" },
    ],
  };
}

const ENABLED_CAPS: CompetitiveIntelCaps = {
  enabled: true,
  priceChangeMinPct: 0,
  maxDigestChanges: 100,
  maxHighlights: 5,
};

// --- caps -------------------------------------------------------------------------------------------

describe("competitive-intel caps", () => {
  it("defaults the module OFF", () => {
    expect(COMPETITIVE_INTEL_DEFAULTS.enabled).toBe(false);
    expect(resolveCompetitiveIntelCaps({}).enabled).toBe(false);
  });

  it("parses the enable flag and numeric tunables from the environment", () => {
    const caps = resolveCompetitiveIntelCaps({
      COMPETITIVE_INTEL_ENABLED: "1",
      COMPETITIVE_INTEL_PRICE_CHANGE_MIN_PCT: "0.1",
      COMPETITIVE_INTEL_MAX_DIGEST_CHANGES: "3",
      COMPETITIVE_INTEL_MAX_HIGHLIGHTS: "2",
    });
    expect(caps).toEqual({
      enabled: true,
      priceChangeMinPct: 0.1,
      maxDigestChanges: 3,
      maxHighlights: 2,
    });
  });

  it("falls back to defaults on invalid/negative values", () => {
    const caps = resolveCompetitiveIntelCaps({
      COMPETITIVE_INTEL_ENABLED: "maybe",
      COMPETITIVE_INTEL_PRICE_CHANGE_MIN_PCT: "-1",
      COMPETITIVE_INTEL_MAX_DIGEST_CHANGES: "0",
      COMPETITIVE_INTEL_MAX_HIGHLIGHTS: "nope",
    });
    expect(caps.enabled).toBe(false);
    expect(caps.priceChangeMinPct).toBe(COMPETITIVE_INTEL_DEFAULTS.priceChangeMinPct);
    expect(caps.maxDigestChanges).toBe(COMPETITIVE_INTEL_DEFAULTS.maxDigestChanges);
    expect(caps.maxHighlights).toBe(COMPETITIVE_INTEL_DEFAULTS.maxHighlights);
  });
});

// --- diff core --------------------------------------------------------------------------------------

describe("diffSnapshots", () => {
  it("treats the first observation as a baseline: launches are new, pricing/messaging are not", () => {
    const changes = diffSnapshots(null, snapshot(), ENABLED_CAPS);
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({ category: "launch", kind: "added", competitorId: "acme" });
    expect(changes[0]!.sourceUrl).toBe("https://acme.test/blog/ai");
  });

  it("detects an added pricing tier with its source", () => {
    const prev = snapshot();
    const next = snapshot({
      pricing: [
        ...prev.pricing,
        { name: "Team", priceUsd: 50, cadence: "monthly", sourceUrl: "https://acme.test/pricing" },
      ],
    });
    const changes = diffSnapshots(prev, next, ENABLED_CAPS);
    const added = changes.find((c) => c.category === "pricing" && c.kind === "added");
    expect(added).toMatchObject({ summary: 'New pricing tier "Team"', after: "$50/mo", before: null });
    expect(added!.sourceUrl).toBe("https://acme.test/pricing");
  });

  it("detects a removed pricing tier", () => {
    const prev = snapshot();
    const next = snapshot({ pricing: prev.pricing.filter((t) => t.name !== "Pro") });
    const changes = diffSnapshots(prev, next, ENABLED_CAPS);
    const removed = changes.find((c) => c.category === "pricing" && c.kind === "removed");
    expect(removed).toMatchObject({ summary: 'Dropped pricing tier "Pro"', before: "$100/mo", after: null });
  });

  it("detects a price change above the threshold and ignores one below it", () => {
    const prev = snapshot();
    // Pro: 100 -> 120 = 20% change.
    const next = snapshot({
      pricing: prev.pricing.map((t) => (t.name === "Pro" ? { ...t, priceUsd: 120 } : t)),
    });
    const flagged = diffSnapshots(prev, next, { ...ENABLED_CAPS, priceChangeMinPct: 0.1 });
    expect(flagged.find((c) => c.category === "pricing" && c.kind === "changed")).toMatchObject({
      before: "$100/mo",
      after: "$120/mo",
    });
    const ignored = diffSnapshots(prev, next, { ...ENABLED_CAPS, priceChangeMinPct: 0.5 });
    expect(ignored.find((c) => c.category === "pricing")).toBeUndefined();
  });

  it("treats a priced→unpriced (contact us) move as material regardless of threshold", () => {
    const prev = snapshot();
    const next = snapshot({
      pricing: prev.pricing.map((t) => (t.name === "Pro" ? { ...t, priceUsd: null, cadence: "custom" } : t)),
    });
    const changes = diffSnapshots(prev, next, { ...ENABLED_CAPS, priceChangeMinPct: 0.99 });
    expect(changes.find((c) => c.category === "pricing" && c.kind === "changed")).toMatchObject({
      after: "custom pricing",
    });
  });

  it("detects a cadence flip (monthly→annual) as a change", () => {
    const prev = snapshot();
    const next = snapshot({
      pricing: prev.pricing.map((t) => (t.name === "Pro" ? { ...t, cadence: "annual" } : t)),
    });
    const changes = diffSnapshots(prev, next, ENABLED_CAPS);
    expect(changes.find((c) => c.category === "pricing" && c.kind === "changed")).toMatchObject({
      before: "$100/mo",
      after: "$100/yr",
    });
  });

  it("detects tagline and value-prop messaging changes", () => {
    const prev = snapshot();
    const next = snapshot({
      messaging: { tagline: "Ship even faster", valueProps: ["No-code", "AI workflows"], sourceUrl: "https://acme.test" },
    });
    const changes = diffSnapshots(prev, next, ENABLED_CAPS);
    expect(changes.find((c) => c.category === "messaging" && c.summary === "Tagline changed")).toMatchObject({
      before: "Ship faster",
      after: "Ship even faster",
    });
    expect(changes.find((c) => c.kind === "added" && c.category === "messaging")).toMatchObject({
      after: "AI workflows",
    });
    expect(changes.find((c) => c.kind === "removed" && c.category === "messaging")).toMatchObject({
      before: "Analytics",
    });
  });

  it("matches names/props case- and whitespace-insensitively (no spurious change)", () => {
    const prev = snapshot();
    const next = snapshot({
      pricing: prev.pricing.map((t) => (t.name === "Pro" ? { ...t, name: "  pro " } : t)),
      messaging: { tagline: "  ship faster ", valueProps: ["no-code", "  Analytics"], sourceUrl: "https://acme.test" },
    });
    expect(diffSnapshots(prev, next, ENABLED_CAPS)).toHaveLength(0);
  });

  it("reports only NEW launches and ignores ones that drop off the page", () => {
    const prev = snapshot({
      launches: [
        { id: "l1", title: "AI Assistant", date: "2026-05-01", sourceUrl: "https://acme.test/blog/ai" },
        { id: "l2", title: "SSO", date: "2026-05-10", sourceUrl: "https://acme.test/blog/sso" },
      ],
    });
    const next = snapshot({
      launches: [
        { id: "l2", title: "SSO", date: "2026-05-10", sourceUrl: "https://acme.test/blog/sso" },
        { id: "l3", title: "Mobile v2", date: "2026-06-01", sourceUrl: "https://acme.test/blog/mobile" },
      ],
    });
    const changes = diffSnapshots(prev, next, ENABLED_CAPS);
    const launchChanges = changes.filter((c) => c.category === "launch");
    expect(launchChanges).toHaveLength(1);
    expect(launchChanges[0]).toMatchObject({ kind: "added", after: "Mobile v2 (2026-06-01)" });
  });

  it("returns an empty change list when nothing material moved", () => {
    expect(diffSnapshots(snapshot(), snapshot(), ENABLED_CAPS)).toHaveLength(0);
  });

  it("orders changes deterministically: pricing, then launch, then messaging", () => {
    const prev = snapshot({ launches: [] });
    const next = snapshot({
      pricing: [
        { name: "Starter", priceUsd: 10, cadence: "monthly", sourceUrl: "s" },
        { name: "Pro", priceUsd: 200, cadence: "monthly", sourceUrl: "s" }, // changed
        { name: "Enterprise", priceUsd: null, cadence: "custom", sourceUrl: "s" },
      ],
      messaging: { tagline: "New tagline", valueProps: ["No-code", "Analytics"], sourceUrl: "m" },
      launches: [{ id: "lx", title: "Launch X", date: "2026-06-01", sourceUrl: "b" }],
    });
    const cats = diffSnapshots(prev, next, ENABLED_CAPS).map((c) => c.category);
    expect(cats).toEqual(["pricing", "launch", "messaging"]);
  });
});

// --- buildDigest ------------------------------------------------------------------------------------

describe("buildDigest", () => {
  function change(over: Partial<MaterialChange>): MaterialChange {
    return {
      competitorId: "acme",
      competitorName: "Acme",
      category: "pricing",
      kind: "changed",
      summary: "x",
      before: null,
      after: null,
      sourceUrl: null,
      ...over,
    };
  }

  it("tallies counts, dedupes sources, and caps highlights", () => {
    const digest = buildDigest({
      workspaceId: "ws1",
      competitorIds: ["acme"],
      generatedAt: "2026-06-22T00:00:00.000Z",
      servedBy: "live",
      caps: { ...ENABLED_CAPS, maxHighlights: 2 },
      changes: [
        change({ category: "pricing", summary: "p1", sourceUrl: "https://a/pricing" }),
        change({ category: "launch", kind: "added", summary: "l1", sourceUrl: "https://a/blog" }),
        change({ category: "launch", kind: "added", summary: "l2", sourceUrl: "https://a/blog" }),
        change({ category: "messaging", summary: "m1", sourceUrl: null }),
      ],
    });
    expect(digest.counts).toEqual({ pricing: 1, messaging: 1, launch: 2, total: 4 });
    expect(digest.sources).toEqual(["https://a/pricing", "https://a/blog"]);
    expect(digest.highlights).toHaveLength(2);
    expect(digest.highlights[0]).toContain("[PRICING]");
  });

  it("caps the number of changes at maxDigestChanges", () => {
    const changes = Array.from({ length: 5 }, (_, i) =>
      change({ summary: `c${i}`, competitorId: `c${i}` }),
    );
    const digest = buildDigest({
      workspaceId: "ws1",
      competitorIds: ["acme"],
      generatedAt: "2026-06-22T00:00:00.000Z",
      servedBy: "live",
      caps: { ...ENABLED_CAPS, maxDigestChanges: 2 },
      changes,
    });
    expect(digest.changes).toHaveLength(2);
    expect(digest.counts.total).toBe(2);
  });
});

// --- providers --------------------------------------------------------------------------------------

describe("competitor sources", () => {
  it("FakeCompetitorIntelSource is deterministic for a given competitor", async () => {
    const src = new FakeCompetitorIntelSource();
    const a = await src.fetchSnapshot(ACME);
    const b = await src.fetchSnapshot(ACME);
    expect(a).toEqual(b);
    expect(src.live).toBe(false);
    expect(a.pricing.length).toBeGreaterThan(0);
    expect(a.messaging.sourceUrl).toBe("https://acme.test");
  });

  it("FakeCompetitorIntelSource differs across competitors", async () => {
    const src = new FakeCompetitorIntelSource();
    const a = await src.fetchSnapshot(ACME);
    const r = await src.fetchSnapshot(RIVAL);
    expect(a).not.toEqual(r);
  });

  it("StaticCompetitorIntelSource serves supplied snapshots and can be forced to throw", async () => {
    const ok = new StaticCompetitorIntelSource({ snapshots: [snapshot()] });
    expect((await ok.fetchSnapshot(ACME)).messaging.tagline).toBe("Ship faster");
    const boom = new StaticCompetitorIntelSource({ throwOnFetch: true });
    await expect(boom.fetchSnapshot(ACME)).rejects.toThrow();
  });

  it("EmptyCompetitorIntelSource observes nothing", async () => {
    const snap = await new EmptyCompetitorIntelSource().fetchSnapshot(ACME);
    expect(snap.pricing).toEqual([]);
    expect(snap.launches).toEqual([]);
  });
});

// --- service ----------------------------------------------------------------------------------------

describe("CompetitiveIntelService", () => {
  function makeStore() {
    return new InMemoryCompetitiveIntelStore();
  }

  it("disabled (default): serves fake data, makes NO call to the injected source, never falls back to network", async () => {
    const throwing = new StaticCompetitorIntelSource({ throwOnFetch: true });
    const svc = new CompetitiveIntelService({
      store: makeStore(),
      source: throwing, // would throw if ever called
      caps: { ...ENABLED_CAPS, enabled: false },
      now: fixedClock(),
    });
    const { digest } = await svc.generateDigest({ workspaceId: "ws1", competitors: [ACME] });
    expect(digest.servedBy).toBe("fake-disabled");
    // Fake data is deterministic, so the baseline run reports its launches (no throw means source untouched).
    expect(digest.competitorIds).toEqual(["acme"]);
  });

  it("enabled with a live source: baseline run, then a second run reports the material change as 'live'", async () => {
    const store = makeStore();
    const week1 = new StaticCompetitorIntelSource({ snapshots: [snapshot()] });
    const r1 = await new CompetitiveIntelService({
      store,
      source: week1,
      caps: ENABLED_CAPS,
      now: fixedClock(Date.parse("2026-06-15T00:00:00.000Z")),
    }).generateDigest({ workspaceId: "ws1", competitors: [ACME] });
    expect(r1.digest.servedBy).toBe("live");
    expect(r1.digest.changes.filter((c) => c.category === "pricing")).toHaveLength(0); // baseline

    const week2 = new StaticCompetitorIntelSource({
      snapshots: [
        snapshot({
          pricing: [
            { name: "Starter", priceUsd: 15, cadence: "monthly", sourceUrl: "https://acme.test/pricing" },
            { name: "Pro", priceUsd: 100, cadence: "monthly", sourceUrl: "https://acme.test/pricing" },
            { name: "Enterprise", priceUsd: null, cadence: "custom", sourceUrl: "https://acme.test/pricing" },
          ],
        }),
      ],
    });
    const r2 = await new CompetitiveIntelService({
      store,
      source: week2,
      caps: ENABLED_CAPS,
      now: fixedClock(),
    }).generateDigest({ workspaceId: "ws1", competitors: [ACME] });
    expect(r2.digest.servedBy).toBe("live");
    const priced = r2.digest.changes.find((c) => c.category === "pricing");
    expect(priced).toMatchObject({ kind: "changed", before: "$10/mo", after: "$15/mo" });
    expect(r2.digest.sources).toContain("https://acme.test/pricing");
  });

  it("enabled but the live source throws: falls back to the fake and tags 'fake-fallback'", async () => {
    const svc = new CompetitiveIntelService({
      store: makeStore(),
      source: new StaticCompetitorIntelSource({ throwOnFetch: true }),
      caps: ENABLED_CAPS,
      now: fixedClock(),
    });
    const { digest } = await svc.generateDigest({ workspaceId: "ws1", competitors: [ACME] });
    expect(digest.servedBy).toBe("fake-fallback");
  });

  it("persists and reads back digests newest-first, scoped per workspace (IDOR)", async () => {
    const store = makeStore();
    const svc = new CompetitiveIntelService({ store, caps: ENABLED_CAPS, now: fixedClock() });
    const a = await svc.generateDigest({ workspaceId: "wsA", competitors: [ACME] });
    await svc.generateDigest({ workspaceId: "wsA", competitors: [RIVAL] });
    await svc.generateDigest({ workspaceId: "wsB", competitors: [ACME] });

    const listA = await svc.listDigests("wsA");
    expect(listA).toHaveLength(2);
    expect(listA[0]!.generatedAt.getTime()).toBeGreaterThanOrEqual(listA[1]!.generatedAt.getTime());

    // A digest created in wsA is invisible to wsB.
    expect(await svc.getDigest("wsB", a.record.id)).toBeNull();
    expect(await svc.getDigest("wsA", a.record.id)).not.toBeNull();
  });

  it("keeps competitor snapshots isolated per workspace when diffing", async () => {
    const store = makeStore();
    // wsA sees Pro at $100; wsB has never seen Acme, so wsB's first run is a baseline (no pricing change).
    await new CompetitiveIntelService({ store, source: new StaticCompetitorIntelSource({ snapshots: [snapshot()] }), caps: ENABLED_CAPS, now: fixedClock() })
      .generateDigest({ workspaceId: "wsA", competitors: [ACME] });
    const r = await new CompetitiveIntelService({
      store,
      source: new StaticCompetitorIntelSource({
        snapshots: [snapshot({ pricing: [{ name: "Pro", priceUsd: 999, cadence: "monthly", sourceUrl: "s" }] })],
      }),
      caps: ENABLED_CAPS,
      now: fixedClock(),
    }).generateDigest({ workspaceId: "wsB", competitors: [ACME] });
    expect(r.digest.changes.filter((c) => c.category === "pricing")).toHaveLength(0);
  });

  it("handles an empty competitor list with an empty digest", async () => {
    const svc = new CompetitiveIntelService({ store: makeStore(), caps: ENABLED_CAPS, now: fixedClock() });
    const { digest } = await svc.generateDigest({ workspaceId: "ws1", competitors: [] });
    expect(digest.changes).toEqual([]);
    expect(digest.counts.total).toBe(0);
  });

  it("exposes the resolved caps via policy", () => {
    const svc = new CompetitiveIntelService({ store: makeStore(), caps: ENABLED_CAPS });
    expect(svc.policy.enabled).toBe(true);
  });
});
