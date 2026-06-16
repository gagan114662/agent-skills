import { desc, eq, sql } from "drizzle-orm";
import { db } from "../index.js";
import { seoRankObservations } from "../schema/index.js";
import {
  PAGE_ONE_MAX_POSITION,
  type RankObservation,
  type SearchEngine,
} from "../../seo/types.js";

/**
 * SEO rank observation repository (#294) — the store the {@link SeoRankService} writes external receipts
 * through and the founder console / routes read rankings from. Tenant-scoped throughout (#3). Ingest is
 * idempotent via the `(workspace_id, provider, external_id)` unique index: re-reporting the same provider
 * receipt updates the row instead of stacking duplicates. Every read is grounded in a real receipt row —
 * there is no self-reported path (premortem §2).
 */

/** A latest-position-per-keyword reading for the founder console / summary route. */
export interface KeywordRankReading {
  keyword: string;
  url: string;
  position: number | null;
  searchEngine: SearchEngine;
  country: string;
  observedAtMs: number;
}

export interface SeoRankStore {
  /** Record (idempotent upsert) a batch of external rank receipts. Returns the count written. */
  record(workspaceId: string, observations: ReadonlyArray<RankObservation>): Promise<number>;
  /** Total observation rows for a workspace (proof the tile is connected at all). */
  count(workspaceId: string): Promise<number>;
  /** Distinct keywords currently sitting on page 1 (position 1..10) as of their latest observation. */
  countKeywordsOnPageOne(workspaceId: string, since?: Date): Promise<number>;
  /** The latest observation per keyword, newest first. */
  latestByKeyword(workspaceId: string, limit?: number): Promise<KeywordRankReading[]>;
  /** Raw recent observations (audit surface), newest first. */
  listObservations(workspaceId: string, limit?: number): Promise<KeywordRankReading[]>;
}

export const dbSeoRankStore: SeoRankStore = {
  async record(workspaceId, observations) {
    if (observations.length === 0) return 0;
    let written = 0;
    for (const o of observations) {
      await db
        .insert(seoRankObservations)
        .values({
          workspaceId,
          keyword: o.keyword,
          url: o.url,
          position: o.position,
          searchEngine: o.searchEngine,
          country: o.country,
          provider: o.provider,
          externalId: o.externalId,
          observedAt: new Date(o.observedAtMs),
          detail: o.detail,
        })
        .onConflictDoUpdate({
          target: [
            seoRankObservations.workspaceId,
            seoRankObservations.provider,
            seoRankObservations.externalId,
          ],
          set: {
            keyword: o.keyword,
            url: o.url,
            position: o.position,
            searchEngine: o.searchEngine,
            country: o.country,
            observedAt: new Date(o.observedAtMs),
            detail: o.detail,
          },
        });
      written += 1;
    }
    return written;
  },

  async count(workspaceId) {
    const rows = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(seoRankObservations)
      .where(eq(seoRankObservations.workspaceId, workspaceId));
    return rows[0]?.n ?? 0;
  },

  async countKeywordsOnPageOne(workspaceId, since) {
    // The latest observation per keyword; count those whose latest position is on page 1.
    const reads = await this.latestByKeyword(workspaceId, 1000);
    const fresh = since ? reads.filter((r) => r.observedAtMs >= since.getTime()) : reads;
    return fresh.filter((r) => r.position !== null && r.position <= PAGE_ONE_MAX_POSITION).length;
  },

  async latestByKeyword(workspaceId, limit = 200) {
    // One row per keyword = the most recent observation. DISTINCT ON (keyword) ordered by observed_at desc.
    const rows = await db
      .selectDistinctOn([seoRankObservations.keyword], {
        keyword: seoRankObservations.keyword,
        url: seoRankObservations.url,
        position: seoRankObservations.position,
        searchEngine: seoRankObservations.searchEngine,
        country: seoRankObservations.country,
        observedAt: seoRankObservations.observedAt,
      })
      .from(seoRankObservations)
      .where(eq(seoRankObservations.workspaceId, workspaceId))
      .orderBy(seoRankObservations.keyword, desc(seoRankObservations.observedAt))
      .limit(limit);
    return rows
      .map((r) => ({
        keyword: r.keyword,
        url: r.url,
        position: r.position,
        searchEngine: r.searchEngine as SearchEngine,
        country: r.country,
        observedAtMs: r.observedAt.getTime(),
      }))
      .sort((a, b) => (a.position ?? 999) - (b.position ?? 999));
  },

  async listObservations(workspaceId, limit = 100) {
    const rows = await db
      .select({
        keyword: seoRankObservations.keyword,
        url: seoRankObservations.url,
        position: seoRankObservations.position,
        searchEngine: seoRankObservations.searchEngine,
        country: seoRankObservations.country,
        observedAt: seoRankObservations.observedAt,
      })
      .from(seoRankObservations)
      .where(eq(seoRankObservations.workspaceId, workspaceId))
      .orderBy(desc(seoRankObservations.observedAt))
      .limit(limit);
    return rows.map((r) => ({
      keyword: r.keyword,
      url: r.url,
      position: r.position,
      searchEngine: r.searchEngine as SearchEngine,
      country: r.country,
      observedAtMs: r.observedAt.getTime(),
    }));
  },
};
