import { describe, it, expect, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { AddressInfo } from "node:net";
import { buildApp } from "../../src/app.js";
import { db, closeDb } from "../../src/db/index.js";
import { closeRedis } from "../../src/redis/index.js";
import { workspaces } from "../../src/db/schema/index.js";
import { newId } from "../../src/db/id.js";
import { BillingManager } from "../../src/billing/manager.js";
import { NoneBillingProvider } from "../../src/billing/none-provider.js";
import { PlanBillingService } from "../../src/billing/plan-service.js";
import { dbBillingStore } from "../../src/db/repositories/billing.js";
import { dbPlanPriceStore, dbWorkspacePlanStore } from "../../src/db/repositories/plans.js";
import { signWebhookPayload } from "../../src/billing/webhook.js";
import { channelPoster } from "../../src/runtime/default.js";
import { StaticSecretsResolver } from "../../src/runtime/secrets-resolver.js";
import { CONFIG_DEFAULTS, type BillingConfig } from "../../src/config/schema.js";
import { getPlan, planCaps } from "../../src/billing/plans.js";
import type { BillingStatus } from "../../src/billing/mode.js";
import type { SessionLogger } from "../../src/runtime/manager.js";

const silentLogger: SessionLogger = {
  child: () => silentLogger,
  info: () => {},
  warn: () => {},
  error: () => {},
};

const STRIPE_KEY = "sk-live-pricing-secret-xyz";
const WHSEC = "whsec_pricing_secret_abc";

const apps: FastifyInstance[] = [];
const slugs: string[] = [];

afterAll(async () => {
  for (const slug of slugs) await db.delete(workspaces).where(eq(workspaces.slug, slug));
  for (const app of apps) await app.close();
  await Promise.allSettled([closeDb(), closeRedis()]);
});

async function startApp(
  opts: { billing?: BillingConfig; status?: BillingStatus } = {},
): Promise<FastifyInstance> {
  const loadConfig = () => ({ ...CONFIG_DEFAULTS, billing: opts.billing });
  const secrets = new StaticSecretsResolver({
    STRIPE_SECRET_KEY: STRIPE_KEY,
    STRIPE_WEBHOOK_SECRET: WHSEC,
  });
  const provider = new NoneBillingProvider();
  const planService = new PlanBillingService({
    provider,
    prices: dbPlanPriceStore,
    plans: dbWorkspacePlanStore,
    secrets,
    loadConfig,
    logger: silentLogger,
  });
  const billingManager = new BillingManager({
    provider,
    store: dbBillingStore,
    poster: channelPoster,
    secrets,
    deployments: { latestForSession: () => Promise.resolve(undefined) },
    planActivator: planService,
    loadConfig,
    logger: silentLogger,
  });
  const app = buildApp({ billingManager, planService, ...(opts.status ? { billingStatus: opts.status } : {}) });
  apps.push(app);
  await app.listen({ port: 0, host: "127.0.0.1" });
  void (app.server.address() as AddressInfo);
  return app;
}

interface World {
  cookie: string;
  workspaceId: string;
}

async function seed(app: FastifyInstance): Promise<World> {
  const slug = `pricing-${newId()}`;
  slugs.push(slug);
  const signup = await app.inject({
    method: "POST",
    url: "/auth/signup",
    payload: { email: `u-${newId()}@e.com`, password: "pw", displayName: "U", workspaceSlug: slug },
  });
  const cookie = signup.cookies.find((c) => c.name === "rid")!.value;
  const me = (await app.inject({ method: "GET", url: "/me", cookies: { rid: cookie } })).json();
  return { cookie, workspaceId: me.workspaceId };
}

/** A Stripe-shaped checkout.session.completed event carrying the plan-checkout metadata. */
function planPaymentEvent(workspaceId: string, planKey: string): string {
  return JSON.stringify({
    id: `evt_${newId()}`,
    type: "checkout.session.completed",
    data: {
      object: {
        amount_total: getPlan(planKey)!.priceCents,
        currency: "usd",
        status: "complete",
        payment_status: "paid",
        metadata: { workspaceId, planKey, kind: "plan_checkout" },
      },
    },
  });
}

const BILLING_CFG: BillingConfig = { provider: "none", currency: "usd" };

describe("Pricing + Stripe checkout (#125 — real Postgres + Redis, no-network none provider)", () => {
  it("renders the catalog, then plan-click → checkout → signed webhook → plan active → caps updated", async () => {
    const app = await startApp({ billing: BILLING_CFG });
    const w = await seed(app);

    // /pricing data: three plans, no active plan yet.
    const listed = (
      await app.inject({
        method: "GET",
        url: `/workspaces/${w.workspaceId}/billing/plans`,
        cookies: { rid: w.cookie },
      })
    ).json();
    expect(listed.plans.map((p: { key: string }) => p.key)).toEqual(["starter", "pro", "agency"]);
    expect(listed.current).toBeNull();

    // Click "Pro" → a real checkout link (minted via the #98 provider seam).
    const checkout = await app.inject({
      method: "POST",
      url: `/workspaces/${w.workspaceId}/billing/checkout`,
      cookies: { rid: w.cookie },
      payload: { planKey: "pro" },
    });
    expect(checkout.statusCode).toBe(201);
    expect(checkout.json().url).toMatch(/^https:\/\/.+/);

    // The merged, signature-verified webhook activates the plan.
    const raw = planPaymentEvent(w.workspaceId, "pro");
    const sig = signWebhookPayload(raw, WHSEC, Math.floor(Date.now() / 1000));
    const hook = await app.inject({
      method: "POST",
      url: `/billing/webhook/${w.workspaceId}`,
      headers: { "content-type": "application/json", "stripe-signature": sig },
      payload: raw,
    });
    expect(hook.statusCode).toBe(200);

    // Plan is now active and the tenant caps match the Pro catalog entry (caps updated).
    const after = (
      await app.inject({
        method: "GET",
        url: `/workspaces/${w.workspaceId}/billing/plans`,
        cookies: { rid: w.cookie },
      })
    ).json();
    const proCaps = planCaps(getPlan("pro")!);
    expect(after.current.planKey).toBe("pro");
    expect(after.current.agentSeats).toBe(proCaps.agentSeats);
    expect(after.current.monthlySessionBudgetCents).toBe(proCaps.monthlySessionBudgetCents);
    expect(after.current.fleetSize).toBe(proCaps.fleetSize);

    // Revenue/evidence still flows to the #96 scorecard surface (unchanged #98 behavior).
    const revenue = (
      await app.inject({
        method: "GET",
        url: `/workspaces/${w.workspaceId}/billing/revenue`,
        cookies: { rid: w.cookie },
      })
    ).json();
    expect(revenue.paymentCount).toBe(1);
    expect(revenue.evidenceCount).toBe(1);

    // A replayed webhook is idempotent — the plan stays Pro, no second activation.
    const replay = await app.inject({
      method: "POST",
      url: `/billing/webhook/${w.workspaceId}`,
      headers: { "content-type": "application/json", "stripe-signature": sig },
      payload: raw,
    });
    expect(replay.json().deduped).toBe(true);
    const stillPro = (
      await app.inject({
        method: "GET",
        url: `/workspaces/${w.workspaceId}/billing/plans`,
        cookies: { rid: w.cookie },
      })
    ).json();
    expect(stillPro.current.planKey).toBe("pro");
  });

  it("returns 409 on checkout when the tenant has not enabled billing (opt-in)", async () => {
    const app = await startApp({}); // no billing config
    const w = await seed(app);
    const res = await app.inject({
      method: "POST",
      url: `/workspaces/${w.workspaceId}/billing/checkout`,
      cookies: { rid: w.cookie },
      payload: { planKey: "pro" },
    });
    expect(res.statusCode).toBe(409);
    // But the catalog still renders so the page is never blank.
    const listed = await app.inject({
      method: "GET",
      url: `/workspaces/${w.workspaceId}/billing/plans`,
      cookies: { rid: w.cookie },
    });
    expect(listed.statusCode).toBe(200);
    expect(listed.json().plans).toHaveLength(3);
  });

  it("rejects an unknown plan key with 400", async () => {
    const app = await startApp({ billing: BILLING_CFG });
    const w = await seed(app);
    const res = await app.inject({
      method: "POST",
      url: `/workspaces/${w.workspaceId}/billing/checkout`,
      cookies: { rid: w.cookie },
      payload: { planKey: "enterprise" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("reports go-live status: test/none by default, live only when stripe runs live (#481)", async () => {
    // Default (no override): the no-network none provider in test mode → never live.
    const testApp = await startApp({ billing: BILLING_CFG });
    const tw = await seed(testApp);
    const testStatus = (
      await testApp.inject({
        method: "GET",
        url: `/workspaces/${tw.workspaceId}/billing/status`,
        cookies: { rid: tw.cookie },
      })
    ).json();
    expect(testStatus).toEqual({ provider: "none", mode: "test", live: false });

    // Owner has flipped go-live: stripe backend + live mode → real money is on.
    const liveApp = await startApp({
      billing: BILLING_CFG,
      status: { provider: "stripe", mode: "live", live: true },
    });
    const lw = await seed(liveApp);
    const liveStatus = (
      await liveApp.inject({
        method: "GET",
        url: `/workspaces/${lw.workspaceId}/billing/status`,
        cookies: { rid: lw.cookie },
      })
    ).json();
    expect(liveStatus).toEqual({ provider: "stripe", mode: "live", live: true });
  });

  it("cannot read another workspace's billing status (IDOR, #481)", async () => {
    const app = await startApp({ billing: BILLING_CFG });
    const a = await seed(app);
    const b = await seed(app);
    const res = await app.inject({
      method: "GET",
      url: `/workspaces/${a.workspaceId}/billing/status`, // A's workspace
      cookies: { rid: b.cookie }, // B's identity
    });
    expect(res.statusCode).toBe(403);
  });

  it("cannot read or check out another workspace's plan (IDOR)", async () => {
    const app = await startApp({ billing: BILLING_CFG });
    const a = await seed(app);
    const b = await seed(app);
    const res = await app.inject({
      method: "POST",
      url: `/workspaces/${a.workspaceId}/billing/checkout`, // A's workspace
      cookies: { rid: b.cookie }, // B's identity
      payload: { planKey: "pro" },
    });
    expect(res.statusCode).toBe(403);
  });
});
