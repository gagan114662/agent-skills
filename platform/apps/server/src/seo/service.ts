/**
 * SEO rank-tracking service (#294). Orchestrates the externally-grounded rank loop:
 *
 *  - `track(workspaceId)` — the proactive FETCH. Gated by `caps.enabled` (default OFF) because a real
 *    provider call costs money / a credential. With the default `dryrun` provider it records nothing, so
 *    the proof tile honestly stays "not connected".
 *  - `recordObservations(...)` — the INGEST path for external receipts that arrive from outside (a Search
 *    Console export, a rank-API webhook, an owner paste). This is always allowed: recording a receipt
 *    someone else produced is not a fetch or a spend, and it is the source of truth for the proof tile.
 *  - `summary(workspaceId)` — the read model (connected?, total receipts, target keywords on page 1, the
 *    latest position per keyword).
 *
 * Every write goes through `decideRankIngest`, so untrusted provider/webhook input is sanitised and a row
 * without a real `externalId` is dropped (premortem §2/§6). The service holds no rank numbers of its own.
 */
import type { FastifyBaseLogger } from "fastify";
import { decideRankIngest } from "./decide.js";
import type { SeoCaps } from "./caps.js";
import type { RankTrackingProvider } from "./rank-provider.js";
import type { KeywordRankReading, SeoRankStore } from "../db/repositories/seo-ranks.js";
import type { ProviderRankRow, RankProviderKind } from "./types.js";

export interface SeoRankDeps {
  store: SeoRankStore;
  caps: (workspaceId: string) => SeoCaps;
  provider: (kind: RankProviderKind) => RankTrackingProvider;
  /** The site whose rankings we track for this workspace (e.g. "https://ipop.ai"). */
  siteUrl: (workspaceId: string) => string;
  now: () => Date;
  log?: FastifyBaseLogger;
}

export interface TrackResult {
  ran: boolean;
  reason?: string;
  fetched: number;
  recorded: number;
}

export interface SeoSummary {
  /** True iff at least one external receipt exists — the only thing that makes the tile "connected". */
  connected: boolean;
  provider: RankProviderKind;
  totalObservations: number;
  keywordsOnPageOne: number;
  trackedKeywords: number;
  latest: KeywordRankReading[];
}

export class SeoRankService {
  constructor(private readonly deps: SeoRankDeps) {}

  /** Run one provider fetch for the workspace's target keywords and record the receipts. Default-OFF. */
  async track(workspaceId: string): Promise<TrackResult> {
    const caps = this.deps.caps(workspaceId);
    if (!caps.enabled) {
      return { ran: false, reason: "seo rank tracking disabled for this workspace", fetched: 0, recorded: 0 };
    }
    if (caps.targetKeywords.length === 0) {
      return { ran: false, reason: "no target keywords configured", fetched: 0, recorded: 0 };
    }
    const provider = this.deps.provider(caps.provider);
    const rows = await provider.fetchRankings({
      keywords: caps.targetKeywords,
      siteUrl: this.deps.siteUrl(workspaceId),
      country: caps.defaultCountry,
    });
    const recorded = await this.ingest(workspaceId, rows, caps.provider, caps);
    return { ran: true, fetched: rows.length, recorded };
  }

  /**
   * Ingest external receipts that arrived from outside (webhook / owner paste / GSC export). Always
   * allowed — this records proof someone else produced, it never fetches or spends.
   */
  async recordObservations(
    workspaceId: string,
    rows: ReadonlyArray<ProviderRankRow>,
    provider: RankProviderKind,
  ): Promise<number> {
    return this.ingest(workspaceId, rows, provider, this.deps.caps(workspaceId));
  }

  private async ingest(
    workspaceId: string,
    rows: ReadonlyArray<ProviderRankRow>,
    provider: RankProviderKind,
    caps: SeoCaps,
  ): Promise<number> {
    const observations = decideRankIngest(rows, {
      provider,
      defaultCountry: caps.defaultCountry,
      nowMs: this.deps.now().getTime(),
    });
    return this.deps.store.record(workspaceId, observations);
  }

  async summary(workspaceId: string): Promise<SeoSummary> {
    const caps = this.deps.caps(workspaceId);
    const [total, onPageOne, latest] = await Promise.all([
      this.deps.store.count(workspaceId),
      this.deps.store.countKeywordsOnPageOne(workspaceId),
      this.deps.store.latestByKeyword(workspaceId, 50),
    ]);
    return {
      connected: total > 0,
      provider: caps.provider,
      totalObservations: total,
      keywordsOnPageOne: onPageOne,
      trackedKeywords: caps.targetKeywords.length,
      latest,
    };
  }
}
