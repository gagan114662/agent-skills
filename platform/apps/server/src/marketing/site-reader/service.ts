/**
 * Public-site reader — service + owner-first gate (#363, ADR-0363).
 *
 * Orchestrates the {@link file://./provider.ts IO provider} and the pure {@link file://./distill.ts core}:
 * fetch the owner site's public pages → distill into sanitized {@link SiteFacts} → cache briefly so a
 * burst of briefed launches doesn't re-crawl the site on every one. The IO seam (`marketing/default.ts`)
 * consults {@link shouldReadSiteContent} before constructing a live reader, so the default deployment
 * never crawls anything.
 *
 * GATE (default-OFF, owner-workspace-first): crawling is active only when (1) the #320 context preamble is
 * on (`marketing.injectWorkspaceContext` — the crawl has nowhere to surface otherwise), (2)
 * `marketing.readSiteContent` is set, and (3) this is the designated owner workspace. Fail-closed: an
 * unnamed owner, or the flag off, reads nothing (named-nobody = nobody). Read-only — no write/send/spend.
 */

import { distillSiteFacts, type SiteFacts } from "./distill.js";
import { DryRunSiteReaderProvider, type SiteReaderProvider } from "./provider.js";

/** Default crawl-result cache TTL (ms): re-crawl at most this often per seed across briefed launches. */
export const DEFAULT_CACHE_TTL_MS = 15 * 60_000;

/**
 * The default-OFF, owner-workspace-first gate. Crawling rides on the #320 preamble (it has nowhere else to
 * surface), so it additionally requires `injectWorkspaceContext`. Pure ⇒ unit-testable; the IO seam calls
 * it before building a live reader.
 */
export function shouldReadSiteContent(
  marketing: { injectWorkspaceContext?: boolean; readSiteContent?: boolean; ownerWorkspaceId?: string },
  workspaceId: string,
): boolean {
  if (!marketing.injectWorkspaceContext) return false;
  if (!marketing.readSiteContent) return false;
  return marketing.ownerWorkspaceId !== undefined && marketing.ownerWorkspaceId === workspaceId;
}

export interface SiteReader {
  /** Crawl + distill the seed site (cached). Returns distilled facts (possibly empty — never null). */
  read(seedUrl: string, onLog?: (line: string) => void): Promise<SiteFacts>;
}

interface CacheEntry {
  facts: SiteFacts;
  at: number;
}

/**
 * Build a {@link SiteReader} over a provider with a short in-memory TTL cache (keyed by seed URL). The
 * cache is intentionally process-local and stateless across restarts — no DB, no migration; a missed
 * cache just re-crawls. Defaults to the {@link DryRunSiteReaderProvider} (reads nothing), so an
 * unconfigured caller is inert. The clock is injectable for deterministic tests.
 */
export function createSiteReader(opts: {
  provider?: SiteReaderProvider;
  ttlMs?: number;
  now?: () => number;
} = {}): SiteReader {
  const provider = opts.provider ?? new DryRunSiteReaderProvider();
  const ttlMs = opts.ttlMs ?? DEFAULT_CACHE_TTL_MS;
  const now = opts.now ?? (() => Date.now());
  const cache = new Map<string, CacheEntry>();

  return {
    async read(seedUrl, onLog) {
      const cached = cache.get(seedUrl);
      if (cached && now() - cached.at < ttlMs) return cached.facts;
      const pages = await provider.fetchPages(seedUrl, onLog);
      const facts = distillSiteFacts(seedUrl, pages);
      cache.set(seedUrl, { facts, at: now() });
      return facts;
    },
  };
}
