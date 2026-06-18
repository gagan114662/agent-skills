import type { FastifyInstance } from "fastify";
import { requireIdentity } from "../auth/guard.js";
import { AdsService } from "../ads/service.js";
import { isAdsSpendKind } from "../ads/spend.js";

/**
 * Bid's ad surface (#272, ADR-0272) under `/me/ads/*`, scoped to the caller's workspace (#3).
 *
 *  - `GET  /me/ads`        — honest status: is an ad account connected, is the spend path enabled, the hard
 *    per-action cap, the read-back account/spend state, and per-creative platform review status. Read-only,
 *    no #13 gate (reading status is not money).
 *  - `POST /me/ads/spend`  — request a real ad spend (launch / budget raise / adjustment). EVERY spend is
 *    money-gated: a valid spend within the hard cap parks a #13 owner approval (202 `pending_approval`);
 *    anything refused (off / over cap / unconnected / invalid) returns the honest decision (200). There is
 *    NO autonomous-spend path here.
 */
export interface AdsRoutesOptions {
  service: AdsService;
}

export async function adsRoutes(app: FastifyInstance, opts: AdsRoutesOptions): Promise<void> {
  const { service } = opts;

  app.get("/me/ads", async (req, reply) => {
    const id = await requireIdentity(req, reply);
    if (!id) return;
    return service.status(id.workspaceId);
  });

  app.post("/me/ads/spend", async (req, reply) => {
    const id = await requireIdentity(req, reply);
    if (!id) return;
    const b = (typeof req.body === "object" && req.body !== null ? req.body : {}) as Record<string, unknown>;
    if (typeof b.kind !== "string" || !isAdsSpendKind(b.kind)) {
      return reply.code(400).send({ error: "kind must be one of campaign_launch | budget_raise | spend_adjustment" });
    }
    if (typeof b.amountCents !== "number") {
      return reply.code(400).send({ error: "amountCents (number) required" });
    }
    const result = await service.requestSpend(id, {
      kind: b.kind,
      amountCents: b.amountCents,
      campaignRef: typeof b.campaignRef === "string" ? b.campaignRef : undefined,
    });
    if (result.status === "pending_approval") {
      return reply.code(202).send(result);
    }
    return reply.code(200).send(result);
  });
}
