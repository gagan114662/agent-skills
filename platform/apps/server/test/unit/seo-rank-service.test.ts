/**
 * SEO rank-tracking service tests (#294) over in-memory fakes (no DB). Proves: track() is gated OFF by
 * default and by an empty keyword list; the default dry-run provider records nothing (so the proof tile
 * stays honest); recordObservations() always ingests external receipts; and summary() is connected only
 * when a real receipt exists (premortem §2).
 */
import { describe, expect, it } from "vitest";
import { SeoRankService } from "../../src/seo/service.js";
import { DryRunRankProvider, type RankTrackingProvider } from "../../src/seo/rank-provider.js";
import { SEO_DEFAULTS, type SeoCaps } from "../../src/seo/caps.js";
import { PAGE_ONE_MAX_POSITION, type ProviderRankRow, type RankObservation } from "../../src/seo/types.js";
import type { KeywordRankReading, SeoRankStore } from "../../src/db/repositories/seo-ranks.js";

function makeStore(): SeoRankStore & { rows: RankObservation[] } {
  const rows: RankObservation[] = [];
  return {
    rows,
    async record(_ws, obs) {
      rows.push(...obs);
      return obs.length;
    },
    async count() {
      return rows.length;
    },
    async countKeywordsOnPageOne() {
      return rows.filter((r) => r.position !== null && r.position <= PAGE_ONE_MAX_POSITION).length;
    },
    async latestByKeyword(): Promise<KeywordRankReading[]> {
      return rows.map((r) => ({
        keyword: r.keyword,
        url: r.url,
        position: r.position,
        searchEngine: r.searchEngine,
        country: r.country,
        observedAtMs: r.observedAtMs,
      }));
    },
    async listObservations() {
      return [];
    },
  };
}

function service(over: { caps?: Partial<SeoCaps>; provider?: RankTrackingProvider } = {}) {
  const store = makeStore();
  const caps: SeoCaps = { ...SEO_DEFAULTS, ...over.caps };
  const svc = new SeoRankService({
    store,
    caps: () => caps,
    provider: () => over.provider ?? new DryRunRankProvider(),
    siteUrl: () => "https://ipop.ai",
    now: () => new Date(1_700_000_000_000),
  });
  return { svc, store };
}

describe("SeoRankService.track", () => {
  it("does not run when disabled (default OFF)", async () => {
    const { svc, store } = service();
    const res = await svc.track("ws1");
    expect(res.ran).toBe(false);
    expect(res.reason).toMatch(/disabled/);
    expect(store.rows).toHaveLength(0);
  });

  it("does not run when enabled but no keywords are configured", async () => {
    const { svc } = service({ caps: { enabled: true, targetKeywords: [] } });
    const res = await svc.track("ws1");
    expect(res.ran).toBe(false);
    expect(res.reason).toMatch(/no target keywords/);
  });

  it("runs with the dry-run provider but records nothing (honest 'not connected')", async () => {
    const { svc, store } = service({ caps: { enabled: true, targetKeywords: ["ai marketing agency"] } });
    const res = await svc.track("ws1");
    expect(res.ran).toBe(true);
    expect(res.fetched).toBe(0);
    expect(res.recorded).toBe(0);
    expect(store.rows).toHaveLength(0);
  });

  it("records the valid receipts a real provider returns and drops the rest", async () => {
    const fakeProvider: RankTrackingProvider = {
      kind: "serpapi",
      async fetchRankings(): Promise<ProviderRankRow[]> {
        return [
          { keyword: "ai marketing agency", url: "https://ipop.ai/", position: 3, externalId: "s1" },
          { keyword: "x", url: "https://ipop.ai/", position: 1 }, // no externalId → dropped
        ];
      },
    };
    const { svc, store } = service({
      caps: { enabled: true, provider: "serpapi", targetKeywords: ["ai marketing agency"] },
      provider: fakeProvider,
    });
    const res = await svc.track("ws1");
    expect(res.fetched).toBe(2);
    expect(res.recorded).toBe(1);
    expect(store.rows[0]).toMatchObject({ keyword: "ai marketing agency", position: 3, provider: "serpapi" });
  });
});

describe("SeoRankService.recordObservations + summary", () => {
  it("ingests external receipts regardless of the enabled flag", async () => {
    const { svc, store } = service({ caps: { enabled: false } });
    const n = await svc.recordObservations(
      "ws1",
      [{ keyword: "autonomous marketing agents", url: "https://ipop.ai/blog", position: 8, externalId: "gsc-1" }],
      "search_console",
    );
    expect(n).toBe(1);
    expect(store.rows[0].provider).toBe("search_console");
  });

  it("summary is not connected until a receipt exists, then reports page-1 count", async () => {
    const { svc } = service({ caps: { enabled: true, targetKeywords: ["a", "b"] } });
    let sum = await svc.summary("ws1");
    expect(sum.connected).toBe(false);
    expect(sum.keywordsOnPageOne).toBe(0);
    expect(sum.trackedKeywords).toBe(2);

    await svc.recordObservations(
      "ws1",
      [
        { keyword: "ai marketing agency", url: "https://ipop.ai/", position: 2, externalId: "s1" },
        { keyword: "ai marketing department", url: "https://ipop.ai/", position: 42, externalId: "s2" },
      ],
      "serpapi",
    );
    sum = await svc.summary("ws1");
    expect(sum.connected).toBe(true);
    expect(sum.totalObservations).toBe(2);
    expect(sum.keywordsOnPageOne).toBe(1); // only position 2 is on page 1
  });
});
