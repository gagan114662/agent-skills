/**
 * Cross-industry award-transfer — reference-miner fetch seam (#1547, ADR-1547).
 *
 * The archive in `corpus.ts` is code-authored and self-sufficient (the transfer step needs no network). This
 * seam is the OPTIONAL live miner: it fetches public award case-library write-ups so the archive can be
 * enriched with fresh cases over time. Two implementations, exactly the `site-reader` posture:
 *   - {@link DryRunReferenceMiner} — the **default**: reads NOTHING over the network and returns an empty
 *     set. The default deployment mines nothing; the transfer step runs entirely off the in-code archive.
 *   - {@link LiveReferenceMiner} — opted in (gated) to actually GET a bounded set of case-write-up URLs.
 *
 * SAFETY (SSRF containment, read-only): the live miner validates every URL and redirect hop with the shared
 * public-web guard (DNS resolution, private/reserved-IP blocking, numeric-host blocking, ports 80/443 only),
 * fetches with a timeout + byte cap, and only ever issues GETs — nothing here writes, sends, or spends. The
 * fetched bytes are untrusted DATA for a future distill step; they are never executed and never become
 * instructions (#200 FM#6).
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
} from "../../security/public-web-url.js";

/** Per-request fetch timeout (ms) — a slow/hung write-up can never stall the miner. */
export const MINER_FETCH_TIMEOUT_MS = 8_000;
/** Max bytes of a single write-up body kept (a case page's readable text is small; cap the rest). */
export const MINER_MAX_PAGE_BYTES = 512 * 1024;
/** Max case-write-up URLs fetched in one mining pass. */
export const MINER_MAX_PAGES = 8;
/** Max characters of a kept URL. */
export const MINER_MAX_URL_CHARS = 300;
const MINER_MAX_REDIRECTS = 5;

/** A single fetched case write-up. `html` is the raw, UNTRUSTED response body for a downstream distill step. */
export interface MinedPage {
  url: string;
  status: number;
  html: string;
}

export interface AwardReferenceMiner {
  readonly kind: string;
  /**
   * Fetch up to {@link MINER_MAX_PAGES} of the given public case-write-up URLs. Returns the raw pages. NEVER
   * throws on a fetch failure — a partial/empty set is a valid result (the archive still stands on its own).
   */
  mine(urls: readonly string[], onLog?: (line: string) => void): Promise<MinedPage[]>;
}

/** The non-networked default: reads nothing and logs what a live mining pass WOULD do. */
export class DryRunReferenceMiner implements AwardReferenceMiner {
  readonly kind = "dryrun" as const;

  async mine(urls: readonly string[], onLog?: (line: string) => void): Promise<MinedPage[]> {
    onLog?.(`▸ [dryrun] would mine up to ${Math.min(urls.length, MINER_MAX_PAGES)} case write-up(s) (read-only)`);
    return [];
  }
}

/** The real miner: GETs each allow-listed public case-write-up URL behind the SSRF-safe public-web guard. */
export class LiveReferenceMiner implements AwardReferenceMiner {
  readonly kind = "live" as const;

  constructor(
    private readonly timeoutMs: number = MINER_FETCH_TIMEOUT_MS,
    private readonly maxPages: number = MINER_MAX_PAGES,
    private readonly resolver: HostResolver = defaultPublicWebHostResolver,
    private readonly fetchImpl: PublicWebFetch = defaultPublicWebFetch,
  ) {}

  async mine(urls: readonly string[], onLog?: (line: string) => void): Promise<MinedPage[]> {
    const pages: MinedPage[] = [];
    for (const url of urls) {
      if (pages.length >= this.maxPages) break;
      const p = await this.get(url, onLog);
      if (p) pages.push(p);
    }
    onLog?.(`▸ [live] mined ${pages.length} case write-up(s) (read-only, SSRF-guarded)`);
    return pages;
  }

  /** A single GET with a timeout, byte cap, and hop-by-hop redirect validation. */
  private async get(url: string, onLog?: (line: string) => void): Promise<MinedPage | null> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let closeResponse: (() => Promise<void>) | undefined;
    try {
      let current = await validatePublicWebUrl(url, this.resolver);
      if (!current) {
        onLog?.(`▸ [live] refusing to mine unsafe/non-http(s) url ${url}`);
        return null;
      }
      let res: Response | null = null;
      for (let redirectCount = 0; redirectCount <= MINER_MAX_REDIRECTS; redirectCount += 1) {
        const fetched = await fetchPinnedPublicWebUrl(
          current,
          {
            method: "GET",
            redirect: "manual",
            signal: controller.signal,
            headers: {
              Accept: "text/html",
              "User-Agent": "ipop-award-miner/1.0 (+" + DEFAULT_PUBLIC_APP_ORIGIN + ")",
            },
          },
          this.fetchImpl,
        );
        res = fetched.response;
        closeResponse = fetched.close;
        if (res.status < 300 || res.status > 399) break;
        const location = res.headers.get("location");
        if (!location || redirectCount === MINER_MAX_REDIRECTS) return null;
        const next = await validatePublicWebUrl(location, this.resolver, current.url);
        await closeResponse();
        closeResponse = undefined;
        if (!next) return null;
        current = next;
      }
      if (!res) return null;
      const body = await readPublicWebResponseText(res, MINER_MAX_PAGE_BYTES);
      if (body === null) return null;
      return { url: current.url.href.slice(0, MINER_MAX_URL_CHARS), status: res.status, html: body };
    } catch (err) {
      onLog?.("[live] skip " + url + ": " + (err instanceof Error ? err.message : String(err)));
      return null;
    } finally {
      clearTimeout(timer);
      await closeResponse?.().catch(() => undefined);
    }
  }
}
