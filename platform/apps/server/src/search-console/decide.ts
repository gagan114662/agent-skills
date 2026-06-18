/**
 * The pure gate core for Search Console auto-submit (#265). No IO, no clock (a clock is passed in). Three
 * decisions, all total + fail-closed:
 *
 *  - `decideSitemapSubmission` — validate an untrusted request into a same-origin-locked plan (premortem
 *    §6: a poisoned web read can never get us to submit/ping a foreign host).
 *  - `decideSitemapVerification` — interpret an untrusted `sitemaps.get` response into an acceptance verdict
 *    (premortem §2: "submitted" only counts when Search Console confirms it — never assumed).
 *  - `decideCoverageReading` — interpret an untrusted coverage response into an indexed-page count, or null
 *    when it cannot be parsed (never a fabricated number).
 */

import {
  DEFAULT_SITEMAP_PATH,
  MAX_INDEXING_URLS,
  MAX_URL_LEN,
  sanitizeField,
  toCount,
  type CoverageReading,
  type RawCoverage,
  type RawSitemapStatus,
  type SitemapSubmissionPlanResult,
  type SitemapSubmissionRequest,
  type SitemapVerification,
} from "./types.js";

/**
 * Parse a site/URL string to its HTTPS origin, or null when it is not a valid absolute HTTPS URL. We
 * require HTTPS: a live site Search Console can verify is served over HTTPS, and refusing other schemes
 * (javascript:, data:, http) is part of the injection defense.
 */
export function originOf(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }
  if (url.protocol !== "https:") return null;
  return url.origin;
}

/** True iff `candidate` is a valid absolute HTTPS URL whose origin equals `origin`. Total. */
export function isSameOrigin(candidate: string, origin: string): boolean {
  const o = originOf(candidate);
  return o !== null && o === origin;
}

/**
 * Validate an untrusted submission request into a plan, or reject with a reason. Fail-closed:
 *  - the site URL must be a valid absolute HTTPS URL; its origin scopes everything else;
 *  - the sitemap URL defaults to `${origin}/sitemap.xml`; an explicit one is accepted ONLY if same-origin;
 *  - each indexing URL is sanitised and kept ONLY if it is same-origin; foreign/garbage URLs are dropped
 *    (never an error — the worst case is a smaller plan), then deduped and bounded to MAX_INDEXING_URLS.
 */
export function decideSitemapSubmission(req: SitemapSubmissionRequest): SitemapSubmissionPlanResult {
  if (typeof req.siteUrl !== "string" || req.siteUrl.trim() === "") {
    return { ok: false, reason: "siteUrl is required" };
  }
  const origin = originOf(req.siteUrl);
  if (origin === null) {
    return { ok: false, reason: "siteUrl must be a valid absolute https URL" };
  }

  let sitemapUrl = `${origin}${DEFAULT_SITEMAP_PATH}`;
  if (typeof req.sitemapUrl === "string" && req.sitemapUrl.trim() !== "") {
    const cleaned = sanitizeField(req.sitemapUrl, MAX_URL_LEN);
    if (!isSameOrigin(cleaned, origin)) {
      return { ok: false, reason: "sitemapUrl must be on the same origin as siteUrl" };
    }
    sitemapUrl = new URL(cleaned).toString();
  }

  const rawUrls = Array.isArray(req.urls) ? req.urls : [];
  const seen = new Set<string>();
  const indexingUrls: string[] = [];
  for (const candidate of rawUrls) {
    if (indexingUrls.length >= MAX_INDEXING_URLS) break;
    if (typeof candidate !== "string") continue;
    const cleaned = sanitizeField(candidate, MAX_URL_LEN);
    if (!isSameOrigin(cleaned, origin)) continue; // injection defense: drop foreign/garbage URLs
    const normalized = new URL(cleaned).toString();
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    indexingUrls.push(normalized);
  }

  return { ok: true, plan: { siteUrl: origin, sitemapUrl, indexingUrls } };
}

/**
 * Interpret an untrusted `sitemaps.get` response into an acceptance verdict. `accepted` is true ONLY when
 * Search Console reports the sitemap present (a `path` or `lastSubmitted`) with ZERO errors — a real,
 * external confirmation. A null response (the dry-run provider, or a 404 from Google) is honestly
 * "not accepted, not pending" with zero counts. Numbers are coerced + clamped; nothing is trusted.
 */
export function decideSitemapVerification(
  sitemapUrl: string,
  raw: RawSitemapStatus | null,
): SitemapVerification {
  if (raw === null) {
    return {
      sitemapUrl,
      accepted: false,
      isPending: false,
      errors: 0,
      warnings: 0,
      submittedUrls: 0,
      indexedUrls: 0,
      lastDownloadedMs: null,
    };
  }
  const errors = toCount(raw.errors);
  const warnings = toCount(raw.warnings);
  const present =
    (typeof raw.path === "string" && raw.path.trim() !== "") ||
    (typeof raw.lastSubmitted === "string" && raw.lastSubmitted.trim() !== "");
  const isPending = raw.isPending === true || raw.isPending === "true";

  let submittedUrls = 0;
  let indexedUrls = 0;
  if (Array.isArray(raw.contents)) {
    for (const c of raw.contents) {
      if (c && typeof c === "object") {
        submittedUrls += toCount((c as { submitted?: unknown }).submitted);
        indexedUrls += toCount((c as { indexed?: unknown }).indexed);
      }
    }
  }

  let lastDownloadedMs: number | null = null;
  if (typeof raw.lastDownloaded === "string") {
    const t = Date.parse(raw.lastDownloaded);
    if (Number.isFinite(t)) lastDownloadedMs = t;
  }

  return {
    sitemapUrl,
    accepted: present && errors === 0,
    isPending,
    errors,
    warnings,
    submittedUrls,
    indexedUrls,
    lastDownloadedMs,
  };
}

/**
 * Interpret an untrusted coverage response into an indexed-page reading, or null when it cannot be parsed.
 * Returning null (never 0-as-a-guess) keeps the scorecard honestly "not connected" rather than reporting a
 * fabricated count (premortem §2).
 */
export function decideCoverageReading(raw: RawCoverage | null, nowMs: number): CoverageReading | null {
  if (raw === null || raw.indexedPages === undefined || raw.indexedPages === null) return null;
  const n =
    typeof raw.indexedPages === "number"
      ? raw.indexedPages
      : typeof raw.indexedPages === "string"
        ? Number(raw.indexedPages)
        : NaN;
  if (!Number.isFinite(n) || n < 0) return null;
  return { indexedPages: Math.floor(n), observedAtMs: nowMs };
}
