/**
 * The rank-data provider seam (#294). A {@link RankTrackingProvider} returns the raw rows for a set of
 * target keywords; the service then runs them through `decideRankIngest` and records the survivors as
 * external receipts. The seam exists so a real provider (Google Search Console, a SERP API like SerpApi /
 * DataForSEO) can slot in behind the #192 vault later WITHOUT changing the service, the table, or the
 * proof tile.
 *
 * The DEFAULT is {@link DryRunRankProvider}: it returns nothing. That is deliberate and honest — with no
 * connected provider there are no rankings to report, so the proof tile stays "not connected" rather than
 * showing a fabricated number (premortem §2). Real providers need a credential and are NOT wired here (no
 * credentials in this change); `resolveRankProvider` only ever returns the dry-run provider until one is
 * built behind the vault.
 */
import type { ProviderRankRow, RankProviderKind } from "./types.js";

/** Input to a rank fetch: the keywords to check and the site whose URLs we're looking for. */
export interface RankFetchInput {
  keywords: ReadonlyArray<string>;
  /** The site origin to attribute rankings to (e.g. "https://ipop.ai"). */
  siteUrl: string;
  country: string;
}

export interface RankTrackingProvider {
  readonly kind: RankProviderKind;
  /** Fetch current rankings for the given keywords. Rows are UNTRUSTED until `decideRankIngest` runs. */
  fetchRankings(input: RankFetchInput): Promise<ProviderRankRow[]>;
}

/** The default provider: reports nothing, makes no network call, spends nothing. */
export class DryRunRankProvider implements RankTrackingProvider {
  readonly kind = "dryrun" as const;
  async fetchRankings(): Promise<ProviderRankRow[]> {
    return [];
  }
}

/**
 * Resolve the provider for a workspace. Today every kind maps to the dry-run provider — a live SERP/GSC
 * provider needs a credential from the #192 vault, which is a deliberate follow-up (this change ships no
 * credentials). Keeping the switch here means turning a real provider on later is a one-line change.
 */
export function resolveRankProvider(_kind: RankProviderKind): RankTrackingProvider {
  return new DryRunRankProvider();
}
