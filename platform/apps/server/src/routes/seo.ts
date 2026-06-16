import type { FastifyInstance } from "fastify";
import { requireIdentity } from "../auth/guard.js";
import { SeoRankService } from "../seo/service.js";
import { isRankProviderKind, type ProviderRankRow } from "../seo/types.js";

/**
 * SEO rank-tracking routes (#294) under `/me/seo/*` — thin adapters over {@link SeoRankService}, scoped to
 * the caller's workspace (#3).
 *
 *  - `GET  /me/seo/summary` — connected?, total external receipts, target keywords on page 1, latest
 *    position per keyword. The numbers are external-receipt-grounded only (premortem §2).
 *  - `GET  /me/seo/ranks` — recent raw rank observations (audit surface).
 *  - `POST /me/seo/track` — run ONE provider FETCH now (the cron/owner entrypoint). With the default
 *    `dryrun` provider this records nothing; it never spends without an owner opting in (caps).
 *  - `POST /me/seo/observations` — INGEST external rank receipts (a rank-API webhook / Search Console
 *    export / owner paste). Always allowed; every row is sanitised + must carry the provider's external
 *    id or it is dropped. This is how real rankings flow in without a connected fetch provider.
 *
 * None of these are money actions (tracking a rank is not a spend; the only paid path — a live provider
 * fetch — is gated by `caps.enabled` + a vault credential), so they carry no #13 gate.
 */
export interface SeoRoutesOptions {
  service: SeoRankService;
}

export async function seoRoutes(app: FastifyInstance, opts: SeoRoutesOptions): Promise<void> {
  const { service } = opts;

  app.get("/me/seo/summary", async (req, reply) => {
    const id = await requireIdentity(req, reply);
    if (!id) return;
    return service.summary(id.workspaceId);
  });

  app.get("/me/seo/ranks", async (req, reply) => {
    const id = await requireIdentity(req, reply);
    if (!id) return;
    return { observations: await service.summary(id.workspaceId).then((s) => s.latest) };
  });

  app.post("/me/seo/track", async (req, reply) => {
    const id = await requireIdentity(req, reply);
    if (!id) return;
    return service.track(id.workspaceId);
  });

  app.post("/me/seo/observations", async (req, reply) => {
    const id = await requireIdentity(req, reply);
    if (!id) return;
    const body = (req.body ?? {}) as { provider?: unknown; observations?: unknown };
    if (typeof body.provider !== "string" || !isRankProviderKind(body.provider) || body.provider === "dryrun") {
      return reply.code(400).send({ error: "provider must be one of search_console|serpapi|dataforseo" });
    }
    if (!Array.isArray(body.observations)) {
      return reply.code(400).send({ error: "observations must be an array" });
    }
    const recorded = await service.recordObservations(
      id.workspaceId,
      body.observations as ProviderRankRow[],
      body.provider,
    );
    return { recorded };
  });
}
