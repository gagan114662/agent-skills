import type { FastifyInstance } from "fastify";
import { requireIdentity } from "../auth/guard.js";
import { SearchConsoleService } from "../search-console/service.js";

/**
 * Search Console auto-submit routes (#265) under `/me/seo/search-console/*` — thin adapters over
 * {@link SearchConsoleService}, scoped to the caller's workspace (#3).
 *
 *  - `GET  /me/seo/search-console/summary` — connected? (a VERIFIED reading exists), the auto-submit flag,
 *    the latest indexed-page count, the latest submission receipt. Externally-grounded only (premortem §2).
 *  - `POST /me/seo/search-console/submit` — ask Scout to submit the sitemap + request indexing. This can
 *    ONLY ever return `disabled` / `not_connected` / `rejected` / `pending_approval` — it never submits
 *    anything live (premortem §4: the live submit is human-gated through the #13 queue).
 *
 * The submit endpoint is NOT a money action (ADR-0243), so it carries no #13 *route* gate; the always-gate
 * is enforced inside the service (it parks a PENDING approval and has no autonomous submit path).
 */
export interface SearchConsoleRoutesOptions {
  service: SearchConsoleService;
}

export const MAX_SEARCH_CONSOLE_SUBMIT_URLS = 1_000;
export const MAX_SEARCH_CONSOLE_URL_CHARS = 2_048;

export async function searchConsoleRoutes(
  app: FastifyInstance,
  opts: SearchConsoleRoutesOptions,
): Promise<void> {
  const { service } = opts;

  app.get("/me/seo/search-console/summary", async (req, reply) => {
    const id = await requireIdentity(req, reply);
    if (!id) return;
    return service.summary(id.workspaceId);
  });

  app.post("/me/seo/search-console/submit", async (req, reply) => {
    const id = await requireIdentity(req, reply);
    if (!id) return;
    const body = (req.body ?? {}) as { sitemapUrl?: unknown; urls?: unknown };
    const sitemapUrl = typeof body.sitemapUrl === "string" ? body.sitemapUrl : undefined;
    if (sitemapUrl && sitemapUrl.length > MAX_SEARCH_CONSOLE_URL_CHARS) {
      return reply.code(400).send({ error: "sitemapUrl is too long" });
    }
    if (Array.isArray(body.urls) && body.urls.length > MAX_SEARCH_CONSOLE_SUBMIT_URLS) {
      return reply.code(400).send({ error: `urls must contain at most ${MAX_SEARCH_CONSOLE_SUBMIT_URLS} entries` });
    }
    const urls = Array.isArray(body.urls) ? body.urls.filter((u): u is string => typeof u === "string") : undefined;
    if (urls?.some((u) => u.length > MAX_SEARCH_CONSOLE_URL_CHARS)) {
      return reply.code(400).send({ error: "urls entries are too long" });
    }
    return service.submitSitemap({
      workspaceId: id.workspaceId,
      requesterMemberId: id.memberId,
      sitemapUrl,
      urls,
    });
  });
}
