/**
 * The Search Console provider seam (#265). A {@link SearchConsoleProvider} performs the four real-world
 * operations the auto-submit loop needs — submit a sitemap, request indexing for a URL, read the sitemap's
 * status (for verification), read coverage (the indexed-page count). The seam exists so a live, fetch-backed
 * provider can slot in behind the #260 Google token (already in the #192 vault) LATER without changing the
 * service, the table, the route, or the scorecard.
 *
 * The DEFAULT is {@link DryRunSearchConsoleProvider}: it makes NO network call, submits nothing, and reports
 * nothing verified. That is deliberate and honest (premortem §2) — with no live provider there is no
 * confirmed submission, so the scorecard stays "not connected" rather than claiming a fabricated success.
 * `resolveSearchConsoleProvider` only ever returns the dry-run provider until a credential is wired behind
 * the vault (a deliberate follow-up; this change connects no real Google account and submits nothing live).
 */
import type {
  IndexingRequestReceipt,
  RawCoverage,
  RawSitemapStatus,
  SearchConsoleProviderKind,
} from "./types.js";

/** The result of a sitemap submit call — `ok` is the provider's own claim, still verified afterwards. */
export interface SitemapSubmitOutcome {
  ok: boolean;
  error?: string;
}

export interface SearchConsoleProvider {
  readonly kind: SearchConsoleProviderKind;
  /** Submit (PUT) a sitemap to Search Console. The claim is NEVER trusted — the service verifies after. */
  submitSitemap(input: { siteUrl: string; sitemapUrl: string }): Promise<SitemapSubmitOutcome>;
  /** Request indexing for one URL (urlNotifications). Returns a receipt, or null when nothing was sent. */
  requestIndexing(input: { siteUrl: string; url: string }): Promise<IndexingRequestReceipt | null>;
  /** Read the sitemap's current status (sitemaps.get) for verification. Null = unknown / not found. */
  getSitemap(input: { siteUrl: string; sitemapUrl: string }): Promise<RawSitemapStatus | null>;
  /** Read coverage / index status for the site. Null = no reading available (the dry-run default). */
  coverage(input: { siteUrl: string }): Promise<RawCoverage | null>;
}

/** The default provider: submits nothing, reports nothing, makes no network call, spends nothing. */
export class DryRunSearchConsoleProvider implements SearchConsoleProvider {
  readonly kind = "dryrun" as const;
  async submitSitemap(): Promise<SitemapSubmitOutcome> {
    return { ok: false, error: "dryrun: no live Search Console provider connected — nothing submitted" };
  }
  async requestIndexing(): Promise<IndexingRequestReceipt | null> {
    return null;
  }
  async getSitemap(): Promise<RawSitemapStatus | null> {
    return null;
  }
  async coverage(): Promise<RawCoverage | null> {
    return null;
  }
}

/**
 * Resolve the provider for a workspace. Today EVERY kind maps to the dry-run provider — a live provider
 * needs the #260 Google token from the #192 vault, which is a deliberate follow-up (this change ships no
 * credentials and submits nothing live). Keeping the switch here means turning a real provider on later is a
 * one-line change, exactly like `resolveRankProvider` (#294).
 */
export function resolveSearchConsoleProvider(_kind: SearchConsoleProviderKind): SearchConsoleProvider {
  return new DryRunSearchConsoleProvider();
}
