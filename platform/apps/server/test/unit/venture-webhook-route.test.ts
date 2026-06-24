import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { WebhookVerificationError, signWebhookPayload } from "../../src/billing/webhook.js";
import { ventureRoutes } from "../../src/routes/venture.js";
import type { MonetizationService } from "../../src/monetization/service.js";
import type { VentureService } from "../../src/venture/service.js";

function buildRoute(opts?: {
  workspaceId?: string | undefined;
  ingest?: MonetizationService["ingestVentureWebhook"];
}) {
  const app = Fastify();
  const calls: Array<{
    workspaceId: string;
    ventureIdeaId: string;
    rawBody: string;
    signature: string | undefined;
  }> = [];
  const ingest =
    opts?.ingest ??
    (async (input: Parameters<MonetizationService["ingestVentureWebhook"]>[0]) => {
      calls.push(input);
      return { deduped: false };
    });

  app.register(ventureRoutes, {
    service: {} as VentureService,
    monetization: { ingestVentureWebhook: ingest } as MonetizationService,
    resolveVentureWorkspaceId: async () => opts?.workspaceId,
  });

  return { app, calls };
}

describe("venture Stripe webhook route (#955)", () => {
  const workspaceId = "ws_venture";
  const ventureId = "venture_123";
  const rawBody = JSON.stringify({
    id: "evt_venture_paid",
    type: "checkout.session.completed",
    data: { object: { amount_total: 4200, currency: "usd", payment_status: "paid" } },
  });

  it("passes the raw signed delivery to monetization with the venture workspace", async () => {
    const { app, calls } = buildRoute({ workspaceId });
    const signature = signWebhookPayload(rawBody, "whsec_route", Math.floor(Date.now() / 1000));

    const res = await app.inject({
      method: "POST",
      url: `/ventures/${ventureId}/stripe-webhook`,
      headers: {
        "content-type": "application/json",
        "stripe-signature": signature,
      },
      payload: rawBody,
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ received: true, deduped: false });
    expect(calls).toEqual([
      { workspaceId, ventureIdeaId: ventureId, rawBody, signature },
    ]);
    await app.close();
  });

  it("surfaces idempotent replays as received and deduped", async () => {
    const { app } = buildRoute({ workspaceId, ingest: async () => ({ deduped: true }) });

    const res = await app.inject({
      method: "POST",
      url: `/ventures/${ventureId}/stripe-webhook`,
      headers: { "content-type": "application/json" },
      payload: rawBody,
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ received: true, deduped: true });
    await app.close();
  });

  it("returns 400 for invalid signatures", async () => {
    const { app } = buildRoute({
      workspaceId,
      ingest: async () => {
        throw new WebhookVerificationError("signature mismatch");
      },
    });

    const res = await app.inject({
      method: "POST",
      url: `/ventures/${ventureId}/stripe-webhook`,
      headers: {
        "content-type": "application/json",
        "stripe-signature": "t=1,v1=bad",
      },
      payload: rawBody,
    });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: "invalid signature" });
    await app.close();
  });

  it("returns 404 before ingest when the venture id is unknown", async () => {
    const { app, calls } = buildRoute({ workspaceId: undefined });

    const res = await app.inject({
      method: "POST",
      url: `/ventures/${ventureId}/stripe-webhook`,
      headers: { "content-type": "application/json" },
      payload: rawBody,
    });

    expect(res.statusCode).toBe(404);
    expect(calls).toHaveLength(0);
    await app.close();
  });
});
