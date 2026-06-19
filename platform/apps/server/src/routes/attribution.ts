import type { FastifyInstance } from "fastify";
import { requireIdentity } from "../auth/guard.js";
import { loadConfig } from "../config/loader.js";
import { attributionActive, maxChainAgeMs, resolveAttributionCaps } from "../attribution/caps.js";
import { projectAttributedRevenue, type AttributionServiceDeps } from "../attribution/service.js";
import { dbAttributionExposureStore } from "../db/repositories/attribution.js";
import { dbRevenueReader } from "../finance/default.js";

/**
 * Attributed-revenue ledger read surface (#386, ADR-0386) under `/me/attribution`, scoped to the caller's
 * workspace (#3, the httpOnly `rid` session cookie identifies it). Returns the attribution projection: which
 * fleet artifacts caused which Stripe receipts, by happened-before causality (L2), every credited dollar
 * backed by an external receipt (L1).
 *
 * **Caps-gated (default OFF, owner-workspace-first):** when attribution is not active for the workspace the
 * endpoint answers `409` — the surface is opt-in, mirroring the finance route. Read-only; no #13 gate
 * (reading the projection is not money). Adds NO money path — it only projects credit over receipts that
 * already exist (the #98 Stripe webhook → revenue_events).
 *
 * NOTE (slice 3): revenue_events do not yet carry a tracking ref, so today every receipt lands in
 * `unattributed` and `byArtifact` is empty until slice 3 stamps the ref into checkout metadata. The
 * projection is honest, never fabricated.
 */
export async function attributionRoutes(app: FastifyInstance): Promise<void> {
  app.get("/me/attribution", async (req, reply) => {
    const id = await requireIdentity(req, reply);
    if (!id) return;
    const caps = resolveAttributionCaps(loadConfig(id.workspaceId).attribution);
    if (!attributionActive(caps, id.workspaceId)) {
      return reply.code(409).send({ error: "attribution is not enabled for this workspace" });
    }
    const deps: AttributionServiceDeps = {
      store: dbAttributionExposureStore,
      revenue: dbRevenueReader,
      maxChainAgeMs: maxChainAgeMs(caps),
      now: () => Date.now(),
    };
    return projectAttributedRevenue(deps, id.workspaceId);
  });
}
