/**
 * Search Console auto-submit (#265) — the pure type + constant vocabulary the sitemap-submit / indexing /
 * coverage loop shares. No IO, no clock.
 *
 * The premortem (#200) sets the rules this module encodes structurally:
 *  - §4 a live submit to Google is an outward action that is not cheaply reversible post-hoc, so it is
 *    PRE-COMMITTED and human-gated (the service has no autonomous submit path — see service.ts).
 *  - §2 "submitted" is not "accepted": a reading only counts when Search Console itself confirms it. The
 *    verification + coverage shapes here are filled ONLY from a provider response, never fabricated.
 *  - §6 the sitemap URL and the indexing URL list are untrusted DATA — they are sanitised and same-origin
 *    locked to the workspace's own site, so a poisoned web read can never steer a submit at a foreign host.
 */

/** The pluggable Search Console providers behind the seam. `dryrun` makes no network call and submits nothing. */
export const SEARCH_CONSOLE_PROVIDER_KINDS = ["dryrun", "search_console"] as const;
export type SearchConsoleProviderKind = (typeof SEARCH_CONSOLE_PROVIDER_KINDS)[number];
export function isSearchConsoleProviderKind(value: string): value is SearchConsoleProviderKind {
  return (SEARCH_CONSOLE_PROVIDER_KINDS as readonly string[]).includes(value);
}

/** Field-length / count bounds — a hostile request or provider response can never blow up a row. */
export const MAX_URL_LEN = 2048;
export const MAX_INDEXING_URLS = 100;
export const MAX_DETAIL_LEN = 500;

/** The default sitemap path appended to a site origin when a request omits an explicit sitemap URL. */
export const DEFAULT_SITEMAP_PATH = "/sitemap.xml";

/** A raw, untrusted submission request (from an agent brief / route body / stored approval payload). */
export interface SitemapSubmissionRequest {
  siteUrl?: unknown;
  /** Optional explicit sitemap URL; must be same-origin or it is rejected. Defaults to `${origin}/sitemap.xml`. */
  sitemapUrl?: unknown;
  /** New/changed URLs to request indexing for; each must be same-origin or it is dropped. */
  urls?: unknown;
}

/** The validated, same-origin-locked plan a submit will act on. All fields are structural DATA. */
export interface SitemapSubmissionPlan {
  /** The site origin (e.g. "https://ipop.ai") the submit is scoped to. */
  siteUrl: string;
  /** The sitemap URL to submit — always same-origin as {@link siteUrl}. */
  sitemapUrl: string;
  /** Same-origin URLs to request indexing for (sanitised, deduped, bounded; may be empty). */
  indexingUrls: string[];
}

export type SitemapSubmissionPlanResult =
  | { ok: true; plan: SitemapSubmissionPlan }
  | { ok: false; reason: string };

/**
 * A raw, untrusted Search Console `sitemaps.get` response (the fields we read). Everything is optional and
 * unknown-typed because it crosses the trust boundary; {@link decideSitemapVerification} coerces + clamps.
 */
export interface RawSitemapStatus {
  path?: unknown;
  lastSubmitted?: unknown;
  lastDownloaded?: unknown;
  isPending?: unknown;
  isSitemapsIndex?: unknown;
  warnings?: unknown;
  errors?: unknown;
  /** Per-content-type counts: [{ type, submitted, indexed }]. */
  contents?: unknown;
}

/** The verdict {@link decideSitemapVerification} produces — filled ONLY from a provider response. */
export interface SitemapVerification {
  sitemapUrl: string;
  /** True iff Search Console reports the sitemap present (path/lastSubmitted) with zero errors. */
  accepted: boolean;
  /** True iff Google is still processing the sitemap. */
  isPending: boolean;
  errors: number;
  warnings: number;
  submittedUrls: number;
  indexedUrls: number;
  /** When Google last downloaded the sitemap (ms), or null if never / unknown. */
  lastDownloadedMs: number | null;
}

/** A raw, untrusted coverage / index-status response. */
export interface RawCoverage {
  indexedPages?: unknown;
}

/** An externally-grounded coverage reading — null when unparseable (never a fabricated count). */
export interface CoverageReading {
  indexedPages: number;
  observedAtMs: number;
}

/** A receipt for one indexing-request ping (Search Console `urlNotifications`). */
export interface IndexingRequestReceipt {
  url: string;
  requested: boolean;
  /** The provider's own notification id — the proof it came from outside. */
  externalId: string | null;
}

/**
 * Strip control characters and clamp length — sitemap/indexing URLs are structural data, never instructions.
 * Implemented via a codepoint check (not a control-char regex literal) so the source stays clean.
 */
export function sanitizeField(value: string, max: number): string {
  let out = "";
  for (const ch of value) {
    const code = ch.codePointAt(0) ?? 0;
    out += code < 0x20 || code === 0x7f ? " " : ch;
  }
  return out.trim().slice(0, max);
}

/** Coerce an untrusted value to a finite non-negative integer, or `fallback` when it cannot. Total. */
export function toCount(value: unknown, fallback = 0): number {
  const n = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  if (!Number.isFinite(n) || n < 0) return fallback;
  return Math.floor(n);
}
