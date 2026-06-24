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
import { TrialNurtureService } from "../../src/billing/trial-nurture.js";
import { dbBillingStore } from "../../src/db/repositories/billing.js";
import {
  dbPlanPriceStore,
  dbPricingExperimentStore,
  dbWorkspacePlanStore,
} from "../../src/db/repositories/plans.js";
import { dbTrialNurtureStore } from "../../src/db/repositories/trial-nurture.js";
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
  const trialNurture = new TrialNurtureService(dbTrialNurtureStore);
  const planService = new PlanBillingService({
    provider,
    prices: dbPlanPriceStore,
    plans: dbWorkspacePlanStore,
    pricingExperiments: dbPricingExperimentStore,
    trialNurture,
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
  const app = buildApp({ billingManager, planService, trialNurture, ...(opts.status ? { billingStatus: opts.status } : {}) });
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
function planPaymentEvent(
  workspaceId: string,
  planKey: string,
  pricing?: { experimentId: string; assignmentId: string; variantKey: string },
): string {
  return JSON.stringify({
    id: `evt_${newId()}`,
    type: "checkout.session.completed",
    data: {
      object: {
        amount_total: getPlan(planKey)!.priceCents,
        currency: "usd",
        status: "complete",
        payment_status: "paid",
        metadata: {
          workspaceId,
          planKey,
          kind: "plan_checkout",
          ...(pricing
            ? {
                pricingExperimentId: pricing.experimentId,
                pricingAssignmentId: pricing.assignmentId,
                pricingVariantKey: pricing.variantKey,
              }
            : {}),
        },
      },
    },
  });
}

const BILLING_CFG: BillingConfig = { provider: "none", currency: "usd" };
const INTEGRATION_TIMEOUT_MS = 45_000;

describe("Pricing + Stripe checkout (#125 — real Postgres + Redis, no-network none provider)", () => {
  it("runs a sticky pricing experiment cohort through checkout, webhook conversion, and impact report", async () => {
    const app = await startApp({ billing: BILLING_CFG });
    const w = await seed(app);

    const created = await app.inject({
      method: "POST",
      url: `/workspaces/${w.workspaceId}/billing/pricing-experiments`,
      cookies: { rid: w.cookie },
      payload: {
        name: "Starter vs Pro",
        controlVariantKey: "starter",
        minSampleSize: 1,
        variants: [
          { key: "starter", planKey: "starter", label: "Starter", weightBps: 5000 },
          { key: "pro", planKey: "pro", label: "Pro", weightBps: 5000 },
        ],
      },
    });
    expect(created.statusCode).toBe(201);
    const experimentId = created.json().id;

    const first = (
      await app.inject({
        method: "GET",
        url: `/workspaces/${w.workspaceId}/billing/plans?visitorKey=buyer-42`,
        cookies: { rid: w.cookie },
      })
    ).json();
    const second = (
      await app.inject({
        method: "GET",
        url: `/workspaces/${w.workspaceId}/billing/plans?visitorKey=buyer-42`,
        cookies: { rid: w.cookie },
      })
    ).json();
    expect(first.pricingExperiment).toMatchObject({ experimentId });
    expect(second.pricingExperiment.assignmentId).toBe(first.pricingExperiment.assignmentId);
    expect(second.pricingExperiment.variantKey).toBe(first.pricingExperiment.variantKey);

    const assignedPlan = first.pricingExperiment.planKey;
    const blocked = await app.inject({
      method: "POST",
      url: `/workspaces/${w.workspaceId}/billing/checkout`,
      cookies: { rid: w.cookie },
      payload: {
        planKey: assignedPlan === "pro" ? "starter" : "pro",
        pricingAssignmentId: first.pricingExperiment.assignmentId,
      },
    });
    expect(blocked.statusCode).toBe(409);

    const checkout = await app.inject({
      method: "POST",
      url: `/workspaces/${w.workspaceId}/billing/checkout`,
      cookies: { rid: w.cookie },
      payload: { planKey: assignedPlan, pricingAssignmentId: first.pricingExperiment.assignmentId },
    });
    expect(checkout.statusCode).toBe(201);

    const raw = planPaymentEvent(w.workspaceId, assignedPlan, {
      experimentId,
      assignmentId: first.pricingExperiment.assignmentId,
      variantKey: first.pricingExperiment.variantKey,
    });
    const sig = signWebhookPayload(raw, WHSEC, Math.floor(Date.now() / 1000));
    const hook = await app.inject({
      method: "POST",
      url: `/billing/webhook/${w.workspaceId}`,
      headers: { "content-type": "application/json", "stripe-signature": sig },
      payload: raw,
    });
    expect(hook.statusCode).toBe(200);

    const report = (
      await app.inject({
        method: "GET",
        url: `/workspaces/${w.workspaceId}/billing/pricing-experiments/${experimentId}/report`,
        cookies: { rid: w.cookie },
      })
    ).json();
    const variant = report.variants.find((v: { variantKey: string }) => v.variantKey === first.pricingExperiment.variantKey);
    expect(variant).toMatchObject({
      assignments: 1,
      checkouts: 1,
      conversions: 1,
      revenueCents: getPlan(assignedPlan)!.priceCents,
      significance: "directional",
    });
  }, INTEGRATION_TIMEOUT_MS);

  it("renders the catalog, then plan-click → checkout → signed webhook → plan active → caps updated", async () => {
    const app = await startApp({ billing: BILLING_CFG });
    const w = await seed(app);

    const nurture = (
      await app.inject({
        method: "GET",
        url: `/workspaces/${w.workspaceId}/billing/trial-nurture`,
        cookies: { rid: w.cookie },
      })
    ).json();
    expect(nurture.inProductNudges[0].key).toBe("first-value");
    expect(nurture.emailDrafts).toHaveLength(2);
    const firstValue = await app.inject({
      method: "POST",
      url: `/workspaces/${w.workspaceId}/billing/trial-nurture/signals`,
      cookies: { rid: w.cookie },
      payload: { kind: "first_value", detail: { source: "integration" } },
    });
    expect(firstValue.statusCode).toBe(200);

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

    const nurtureSummary = (
      await app.inject({
        method: "GET",
        url: `/workspaces/${w.workspaceId}/billing/trial-nurture/summary`,
        cookies: { rid: w.cookie },
      })
    ).json();
    expect(nurtureSummary).toMatchObject({ trials: 1, paid: 1, trialToPaidRate: 1 });

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
  }, INTEGRATION_TIMEOUT_MS);

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
  }, INTEGRATION_TIMEOUT_MS);

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
  }, INTEGRATION_TIMEOUT_MS);

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
  }, INTEGRATION_TIMEOUT_MS);

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
  }, INTEGRATION_TIMEOUT_MS);

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
  }, INTEGRATION_TIMEOUT_MS);
});
