/**
 * The trend-ingestion service (issue #743) — orchestration only. It wires three pure/injected pieces together:
 * the {@link TrendSource} seam (where raw trends come from), the pure ranking core (`rankTrends`), and the
 * {@link TrendStore} (dedupe + persistence). It holds NO ranking logic of its own.
 *
 * The default-OFF + fallback contract lives here:
 *   - `caps.enabled === false` (the default): the LIVE source is never touched — the deterministic fixture is
 *     served, so the module makes zero network calls until an operator opts in.
 *   - `caps.enabled === true`: the live `source` runs; if it throws (network/parse failure), the service falls
 *     back to the fixture rather than failing the caller. The result reports which source actually served it.
 *
 * Output is the ranked {@link TrendRecord} list — directly consumable by the video agent (#740), and also
 * persisted (deduped) for later read-back. `toVideoBriefs` strips a ranked list to the agent's input shape.
 */

import { resolveTrendCaps, type TrendCaps } from "./caps.js";
import { dedupeKey, normalizeText, rankTrends } from "./score.js";
import { FixtureTrendSource, type TrendSource } from "./provider.js";
import type { TrendStore, UpsertTrendInput } from "./store.js";
import type { StoredTrendRecord, TrendRecord, TrendVideoBrief } from "./types.js";

export interface TrendServiceDeps {
  store: TrendStore;
  /** The live source, used only when `caps.enabled`. Defaults to a fixture (offline) for safety. */
  source?: TrendSource;
  /** The deterministic fallback used while disabled or when the live source errors. Defaults to the fixture. */
  fallback?: TrendSource;
  /** Caps override; defaults to env-resolved caps. */
  caps?: TrendCaps;
}

/** Which source actually served a request — useful for honest observability/debugging. */
export type ServedBy = "fixture-disabled" | "live" | "fixture-fallback";

export interface IngestTrendsResult {
  niche: string;
  records: TrendRecord[];
  /** How the result was produced (disabled-fixture, live, or fixture-after-live-error). */
  servedBy: ServedBy;
  /** The id of the {@link TrendSource} that produced the raw trends. */
  sourceId: string;
  /** The persisted rows (deduped), in ranked order. */
  stored: StoredTrendRecord[];
}

export class TrendService {
  private readonly store: TrendStore;
  private readonly source: TrendSource;
  private readonly fallback: TrendSource;
  private readonly caps: TrendCaps;

  constructor(deps: TrendServiceDeps) {
    this.store = deps.store;
    this.fallback = deps.fallback ?? new FixtureTrendSource();
    this.source = deps.source ?? this.fallback;
    this.caps = deps.caps ?? resolveTrendCaps();
  }

  /**
   * Ingest + rank + persist trends for a niche. Empty/whitespace niche short-circuits to an empty result with
   * no source call and no writes. Otherwise: pick the source per the default-OFF contract, fetch (with
   * fallback on live error), rank purely, then upsert the deduped ranked list.
   */
  async ingest(workspaceId: string, niche: string): Promise<IngestTrendsResult> {
    const wantNiche = normalizeText(niche);
    if (wantNiche.length === 0) {
      return { niche: "", records: [], servedBy: "fixture-disabled", sourceId: "none", stored: [] };
    }

    const { raws, servedBy, sourceId } = await this.fetchRaws(wantNiche);
    const records = rankTrends(raws, wantNiche, this.caps);

    const inputs: UpsertTrendInput[] = records.map((record) => ({
      niche: wantNiche,
      record,
      dedupeKey: dedupeKey(record.hook, record.format),
    }));
    const stored = await this.store.upsertMany(workspaceId, inputs);

    return { niche: wantNiche, records, servedBy, sourceId, stored };
  }

  /** Read back a workspace's previously-ingested trends for a niche, ranked. */
  async listByNiche(workspaceId: string, niche: string, limit?: number): Promise<StoredTrendRecord[]> {
    const wantNiche = normalizeText(niche);
    if (wantNiche.length === 0) return [];
    return this.store.listByNiche(workspaceId, wantNiche, limit ?? this.effectiveLimit());
  }

  private effectiveLimit(): number {
    return this.caps.maxResults > 0 ? this.caps.maxResults : 0;
  }

  /**
   * Source selection per the default-OFF + fallback contract:
   *   - disabled  ⇒ fixture only (no network), servedBy `fixture-disabled`.
   *   - enabled   ⇒ live source; on throw, fall back to the fixture, servedBy `fixture-fallback`.
   */
  private async fetchRaws(
    niche: string,
  ): Promise<{ raws: Awaited<ReturnType<TrendSource["fetch"]>>; servedBy: ServedBy; sourceId: string }> {
    if (!this.caps.enabled) {
      const raws = await this.fallback.fetch({ niche });
      return { raws, servedBy: "fixture-disabled", sourceId: this.fallback.id };
    }
    try {
      const raws = await this.source.fetch({ niche });
      return { raws, servedBy: "live", sourceId: this.source.id };
    } catch {
      const raws = await this.fallback.fetch({ niche });
      return { raws, servedBy: "fixture-fallback", sourceId: this.fallback.id };
    }
  }
}

/**
 * Map a ranked trend list to the video agent's input briefs (#740): each ranked trend becomes a `{ hook,
 * format, niche, sourceRef }` brief, preserving rank order. The `score` is dropped — the agent consumes the
 * already-ranked list and only needs the creative payload + attribution.
 */
export function toVideoBriefs(records: readonly TrendRecord[]): TrendVideoBrief[] {
  return records.map((r) => ({ hook: r.hook, format: r.format, niche: r.niche, sourceRef: r.sourceRef }));
}
