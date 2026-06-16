import type { FastifyBaseLogger } from "fastify";
import { loadConfig } from "../config/loader.js";
import { resolveSiteUrl } from "../marketing/site.js";
import { dbSeoRankStore } from "../db/repositories/seo-ranks.js";
import { resolveSeoCaps } from "./caps.js";
import { resolveRankProvider } from "./rank-provider.js";
import { SeoRankService } from "./service.js";

/**
 * Wire the production {@link SeoRankService} (#294). Default-OFF + `dryrun` provider, so a deployment that
 * sets nothing fetches nothing and records nothing — the SEO proof tile stays "not connected" until an
 * owner connects a real rank source. The provider seam resolves to the dry-run provider until a real
 * SERP/GSC provider is built behind the #192 vault (a deliberate follow-up; no credentials in this change).
 */
export function createDefaultSeoRankService(log?: FastifyBaseLogger): SeoRankService {
  return new SeoRankService({
    log,
    store: dbSeoRankStore,
    caps: (workspaceId) => resolveSeoCaps(loadConfig(workspaceId).seo),
    provider: (kind) => resolveRankProvider(kind),
    siteUrl: (workspaceId) => {
      const cfg = loadConfig(workspaceId);
      return (
        resolveSiteUrl({
          workspaceId,
          ownerWorkspaceId: cfg.marketing.ownerWorkspaceId,
          configuredSiteUrl: cfg.marketing.siteUrl,
        }) ?? ""
      );
    },
    now: () => new Date(),
  });
}
