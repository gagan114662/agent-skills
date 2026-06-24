import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { WebhookVerificationError } from "../../src/billing/webhook.js";
import { billingRoutes } from "../../src/routes/billing.js";

function routeHarness(error: WebhookVerificationError) {
  const app = Fastify({ logger: false });
  return app.register(billingRoutes, {
    billingManager: {
      ingestWebhook: async () => {
        throw error;
      },
    },
    planService: {},
    trialNurture: {},
    status: { provider: "stripe", mode: "test", live: false },
  } as never);
}

describe("billing webhook route failures", () => {
  it("returns retryable 503 when the Stripe webhook secret is not configured", async () => {
    const app = await routeHarness(new WebhookVerificationError("no webhook secret configured"));
    const res = await app.inject({
      method: "POST",
      url: "/billing/webhook/ws_1",
      headers: { "content-type": "application/json", "stripe-signature": "t=1,v1=deadbeef" },
      payload: "{}",
    });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ error: "webhook not configured" });
    await app.close();
  });

  it("keeps invalid signatures non-retryable", async () => {
    const app = await routeHarness(new WebhookVerificationError("signature mismatch"));
    const res = await app.inject({
      method: "POST",
      url: "/billing/webhook/ws_1",
      headers: { "content-type": "application/json", "stripe-signature": "t=1,v1=deadbeef" },
      payload: "{}",
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: "invalid signature" });
    await app.close();
  });
});
