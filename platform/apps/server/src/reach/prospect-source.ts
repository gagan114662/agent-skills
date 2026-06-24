import type { Icp, ProspectSourceKind, RawProspect } from "./types.js";

/**
 * The ProspectSource seam (#280 step 2) — the channel-agnostic interface every prospect-data provider
 * implements (mock / Clay / Lusha / Vibe). The loop depends ONLY on this interface, so swapping providers
 * is a config change, not a code change. Providers find net-new prospects with LIVE buying signals through
 * permitted APIs — NEVER by scraping or buying lists.
 *
 * MONEY boundary: a provider declares whether it is `paid` and what a search COSTS ({@link
 * ProspectSource.estimateCostCents}). The service money-gates any non-zero cost (a `data.credit_spend`
 * #13 action) BEFORE the call — buying data credits is the money action. A free provider (the `imported`
 * default) runs autonomously.
 */

export interface ProspectSearchInput {
  icp: Icp;
  /** Max prospects to return this search. */
  limit: number;
  /** Contact keys to exclude (already contacted) — providers should not bill for known prospects. */
  excludeKeys: ReadonlySet<string>;
}

export interface ProspectSearchResult {
  prospects: RawProspect[];
  /** The provider that produced these (e.g. "clay"). */
  provider: string;
  /** Credits actually spent, in cents (0 for free providers). The post-spend amount for the audit. */
  creditsCents: number;
}

export interface ProspectSource {
  readonly kind: ProspectSourceKind;
  /** True when a search spends real money (data credits) — the trigger for money-gating. */
  readonly paid: boolean;
  /** Estimated cost in cents to search for `limit` prospects. 0 ⇒ free ⇒ autonomous. */
  estimateCostCents(limit: number): number;
  /** Find net-new prospects matching the ICP. Throws {@link ProspectSourceUnavailableError} if not configured. */
  search(input: ProspectSearchInput): Promise<ProspectSearchResult>;
}

/**
 * Thrown when a provider can't run — no credential in the #192 vault, or the API is unreachable. The
 * service treats this as "no prospects this run" (it logs + records the run), never as a crash and never
 * as a faked result.
 */
export class ProspectSourceUnavailableError extends Error {
  constructor(
    public readonly kind: ProspectSourceKind,
    message: string,
  ) {
    super(message);
    this.name = "ProspectSourceUnavailableError";
  }
}
