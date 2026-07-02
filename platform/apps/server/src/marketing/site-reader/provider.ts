/**
 * Public-site reader — IO provider seam (#363, ADR-0363).
 *
 * The provider does the network half of the public-site reader: fetch a handful of the owner site's own
 * public pages and hand back their raw (UNTRUSTED) HTML for the pure {@link file://./distill.ts} core to
 * sanitize. Two implementations:
 *   - {@link DryRunSiteReaderProvider} — the **default**: reads NOTHING over the network and returns an
 *     empty page set. With no real fetch wired, the #320 preamble gains no crawled facts (and never any
 *     fabricated ones — #200 FM#2). This is the build+PR posture: the data source exists but is dark.
 *   - {@link LiveSiteReaderProvider} — opted in (config `marketing.readSiteContent` + owner-workspace
 *     gate) to actually crawl the owner's public site read-only.
 *
 * SAFETY (read-only + SSRF containment): the live provider validates each seed and redirect hop with the
 * shared public-web guard (DNS resolution, private/reserved IP blocking, numeric-host blocking, and only
 * ports 80/443). It then only follows same-origin page links. Read-only: it only issues GETs; nothing here
 * writes, sends, or spends. The crawled bytes are untrusted DATA handled exclusively by the distill core.
 */

import { DEFAULT_PUBLIC_APP_ORIGIN } from "../../product-origins.js";
import {
  defaultPublicWebFetch,
  defaultPublicWebHostResolver,
  fetchPinnedPublicWebUrl,
  readPublicWebResponseText,
  validatePublicWebUrl,
  type HostResolver,
  type PublicWebFetch,
  type ValidatedPublicWebUrl,
} from "../../security/public-web-url.js";
import { type FetchedPage, MAX_PAGES, MAX_URL_CHARS } from "./distill.js";

/** Per-request fetch timeout (ms) — a slow/hung page can never stall a launch. */
export const FETCH_TIMEOUT_MS = 8_000;
/** Max bytes of a single page body distilled (a marketing page's `<head>`+hero is tiny; cap the rest). */
export const MAX_PAGE_BYTES = 512 * 1024;
const MAX_REDIRECTS = 5;

export interface SiteReaderProvider {
  readonly kind: string;
  /**
   * Fetch up to {@link MAX_PAGES} public pages starting from `seedUrl` (the owner site). Returns the raw
   * pages for the distill core. NEVER throws on a fetch failure — a partial/empty set is a valid result.
   */
  fetchPages(seedUrl: string, onLog?: (line: string) => void): Promise<FetchedPage[]>;
}

/**
 * The non-networked default: reads nothing and logs what a live crawl WOULD do. The flow stays exercisable
 * end-to-end (the service + preamble just receive zero pages, so they inject no crawled facts), and the
 * default deployment never makes an outbound request from a briefed launch.
 */
export class DryRunSiteReaderProvider implements SiteReaderProvider {
  readonly kind = "dryrun" as const;

  async fetchPages(seedUrl: string, onLog?: (line: string) => void): Promise<FetchedPage[]> {
    onLog?.(`▸ [dryrun] would crawl up to ${MAX_PAGES} public pages from ${seedUrl} (read-only)`);
    return [];
  }
}

/**
 * The real provider: fetches the seed page, discovers a bounded set of same-origin links, and GETs each.
 * Defensive throughout — any single failed/oversized/cross-origin page is skipped, never fatal, so a briefed
 * launch degrades to "fewer facts," never to an error.
 */
export class LiveSiteReaderProvider implements SiteReaderProvider {
  readonly kind = "live" as const;

  constructor(
    private readonly timeoutMs: number = FETCH_TIMEOUT_MS,
    private readonly maxPages: number = MAX_PAGES,
    private readonly resolver: HostResolver = defaultPublicWebHostResolver,
    private readonly fetchImpl: PublicWebFetch = defaultPublicWebFetch,
  ) {}

  async fetchPages(seedUrl: string, onLog?: (line: string) => void): Promise<FetchedPage[]> {
    const seed = await this.parseSeed(seedUrl);
    if (!seed) {
      onLog?.(`▸ [live] refusing to crawl non-http(s) seed ${seedUrl}`);
      return [];
    }
    const pages: FetchedPage[] = [];
    const home = await this.get(seed.url.href, onLog);
    if (home) pages.push(home);

    // Discover a bounded set of same-origin links from the homepage; cross-origin links are dropped.
    const linkBase = home ? new URL(home.url) : seed.url;
    const links = home ? this.sameOriginLinks(home.html, linkBase) : [];
    for (const link of links) {
      if (pages.length >= this.maxPages) break;
      const p = await this.get(link, onLog);
      if (p) pages.push(p);
    }
    onLog?.(`▸ [live] crawled ${pages.length} page(s) from ${seed.url.origin} (read-only)`);
    return pages;
  }

  /** Parse + validate the seed: http(s) only. Returns the URL or null (the caller refuses to crawl). */
  private async parseSeed(seedUrl: string): Promise<ValidatedPublicWebUrl | null> {
    return validatePublicWebUrl(seedUrl, this.resolver);
  }

  /** A single GET with a timeout, byte cap, and hop-by-hop redirect validation. */
  private async get(url: string, onLog?: (line: string) => void): Promise<FetchedPage | null> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let closeResponse: (() => Promise<void>) | undefined;
    try {
      let current = await validatePublicWebUrl(url, this.resolver);
      if (!current) return null;
      let res: Response | null = null;
      for (let redirectCount = 0; redirectCount <= MAX_REDIRECTS; redirectCount += 1) {
        const fetched = await fetchPinnedPublicWebUrl(
          current,
          {
            method: "GET",
            redirect: "manual",
            signal: controller.signal,
            headers: {
              Accept: "text/html",
              "User-Agent": "ipop-site-reader/1.0 (+" + DEFAULT_PUBLIC_APP_ORIGIN + ")",
            },
          },
          this.fetchImpl,
        );
        res = fetched.response;
        closeResponse = fetched.close;
        if (res.status < 300 || res.status > 399) break;
        const location = res.headers.get("location");
        if (!location || redirectCount === MAX_REDIRECTS) return null;
        const next = await validatePublicWebUrl(location, this.resolver, current.url);
        await closeResponse();
        closeResponse = undefined;
        if (!next) return null;
        current = next;
      }
      if (!res) return null;
      const body = await readPublicWebResponseText(res, MAX_PAGE_BYTES);
      if (body === null) return null;
      return { url: current.url.href.slice(0, MAX_URL_CHARS), status: res.status, html: body };
    } catch (err) {
      onLog?.("[live] skip " + url + ": " + (err instanceof Error ? err.message : String(err)));
      return null;
    } finally {
      clearTimeout(timer);
      await closeResponse?.().catch(() => undefined);
    }
  }

  /**
   * Extract same-origin page links from the homepage HTML, de-duplicated and bounded. A link is kept only
   * when it resolves (against the seed) to the SAME origin and an http(s) scheme — a `mailto:`, a fragment,
   * or a cross-origin URL is dropped (SSRF containment). The seed itself is excluded (already fetched).
   */
  private sameOriginLinks(html: string, seed: URL): string[] {
    const out: string[] = [];
    const seen = new Set<string>([seed.href]);
    const re = /href\s*=\s*"([^"#?]+)"/gi;
    let m: RegExpExecArray | null;
    while ((m = re.exec(html)) !== null && out.length < this.maxPages) {
      const href = m[1];
      if (!href) continue;
      let resolved: URL;
      try {
        resolved = new URL(href, seed);
      } catch {
        continue;
      }
      if (resolved.protocol !== "https:" && resolved.protocol !== "http:") continue;
      if (resolved.origin !== seed.origin) continue;
      resolved.hash = "";
      const key = resolved.href;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(key);
    }
    return out;
  }
}
