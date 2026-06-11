import { describe, it, expect, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { AddressInfo } from "node:net";
import { buildApp } from "../../src/app.js";
import { db, closeDb } from "../../src/db/index.js";
import { closeRedis } from "../../src/redis/index.js";
import { workspaces, demandRefunds } from "../../src/db/schema/index.js";
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
import {
  DemandValidationService,
  type CheckoutMinter,
  type LandingDeployer,
  type Refunder,
} from "../../src/demand/service.js";
import { dbExperimentStore, dbSignalStore, dbRefundStore } from "../../src/db/repositories/demand.js";
import type { SessionLogger } from "../../src/runtime/manager.js";

const silentLogger: SessionLogger = {
  child: () => silentLogger,
  info: () => {},
  warn: () => {},
  error: () => {},
};

const STRIPE_KEY = "sk-live-demand-secret-xyz";
const WHSEC = "whsec_demand_secret_abc";
const BILLING_CFG: BillingConfig = { provider: "none", currency: "usd" };
/** Fixed clock: experiment windows are placed in the past so they evaluate as "closed". */
const NOW_MS = 5_000;

const apps: FastifyInstance[] = [];
const slugs: string[] = [];
const refundCalls: { externalRef: string }[] = [];

afterAll(async () => {
  for (const slug of slugs) await db.delete(workspaces).where(eq(workspaces.slug, slug));
  for (const app of apps) await app.close();
  await Promise.allSettled([closeDb(), closeRedis()]);
});

function makeDemandService(): DemandValidationService {
  const deployer: LandingDeployer = { deploy: async ({ experimentId }) => ({ url: `https://land/${experimentId}` }) };
  const checkout: CheckoutMinter = { mint: async ({ experimentId }) => ({ url: `https://pay/${experimentId}` }) };
  const refunder: Refunder = {
    refund: async ({ externalRef }) => void refundCalls.push({ externalRef }),
  };
  return new DemandValidationService({
    experiments: dbExperimentStore,
    signals: dbSignalStore,
    refunds: dbRefundStore,
    deployer,
    checkout,
    refunder,
    now: () => new Date(NOW_MS),
  });
}

async function startApp(): Promise<{ app: FastifyInstance; demand: DemandValidationService }> {
  const loadConfig = () => ({ ...CONFIG_DEFAULTS, billing: BILLING_CFG });
  const secrets = new StaticSecretsResolver({ STRIPE_SECRET_KEY: STRIPE_KEY, STRIPE_WEBHOOK_SECRET: WHSEC });
  const provider = new NoneBillingProvider();
  const demand = makeDemandService();
  const planService = new PlanBillingService({ provider, prices: dbPlanPriceStore, plans: dbWorkspacePlanStore, secrets, loadConfig, logger: silentLogger });
  const billingManager = new BillingManager({
    provider,
    store: dbBillingStore,
    poster: channelPoster,
    secrets,
    deployments: { latestForSession: () => Promise.resolve(undefined) },
    planActivator: planService,
    // #101: the webhook composition under test — a demand_smoke checkout becomes an external paid signal.
    demandIngestor: demand,
    loadConfig,
    logger: silentLogger,
  });
  // Inject the SAME demand instance for the routes + venture overlay (default venture wires opts.demand).
  const app = buildApp({ billingManager, planService, demand });
  apps.push(app);
  await app.listen({ port: 0, host: "127.0.0.1" });
  void (app.server.address() as AddressInfo);
  return { app, demand };
}

interface World {
  cookie: string;
  workspaceId: string;
}

async function seed(app: FastifyInstance): Promise<World> {
  const slug = `demand-${newId()}`;
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

async function createIdea(app: FastifyInstance, w: World): Promise<string> {
  const res = await app.inject({
    method: "POST",
    url: `/workspaces/${w.workspaceId}/ventures`,
    cookies: { rid: w.cookie },
    payload: {
      problem: "manual demand validation is slow",
      targetUser: "solo founders",
      insight: "fake doors beat opinions",
      wedge: "one-command smoke test",
      marketPath: "PLG dev tools",
    },
  });
  expect(res.statusCode).toBe(201);
  return res.json().id;
}

/** A Stripe-shaped payment event carrying the demand_smoke metadata for an experiment. */
function demandPaymentEvent(workspaceId: string, experimentId: string, amountCents: number, eventId: string): string {
  return JSON.stringify({
    id: eventId,
    type: "checkout.session.completed",
    data: {
      object: {
        amount_total: amountCents,
        currency: "usd",
        status: "complete",
        payment_status: "paid",
        metadata: { workspaceId, experimentId, kind: "demand_smoke" },
      },
    },
  });
}

async function fireWebhook(app: FastifyInstance, w: World, raw: string) {
  return app.inject({
    method: "POST",
    url: `/billing/webhook/${w.workspaceId}`,
    // The BillingManager verifies against its REAL clock (only the demand service uses the fixed NOW_MS).
    headers: { "content-type": "application/json", "stripe-signature": signWebhookPayload(raw, WHSEC, Math.floor(Date.now() / 1000)) },
    payload: raw,
  });
}

describe("Demand Validation Rails (#101 — real Postgres + Redis, none provider, no money moved)", () => {
  it("register → launch → funnel signals → signed demand_smoke checkout → PASS, and the scorecard overlay moves only on external evidence", async () => {
    const { app } = await startApp();
    const w = await seed(app);
    const ideaId = await createIdea(app, w);

    // Baseline scorecard BEFORE any external demand evidence (synthetic demand dimension).
    const before = await app.inject({ method: "POST", url: `/workspaces/${w.workspaceId}/ventures/${ideaId}/score`, cookies: { rid: w.cookie } });
    expect(before.statusCode).toBe(200);
    const baselineScore = before.json().score;

    // Register a LOCKED experiment: ≥5% of visitors pay, ≥10 visitors, window already closed at NOW_MS.
    const reg = await app.inject({
      method: "POST",
      url: `/workspaces/${w.workspaceId}/ventures/${ideaId}/experiments`,
      cookies: { rid: w.cookie },
      payload: {
        hypothesis: "Strangers will pay for the smoke test",
        successClass: "paid",
        denominatorClass: "visit",
        passThreshold: 0.05,
        minSample: 10,
        windowStartMs: 0,
        windowEndMs: 1000,
        availability: "available",
      },
    });
    expect(reg.statusCode).toBe(201);
    const experimentId = reg.json().id;

    // Launch the fake-door (available → no disclosure required).
    const launch = await app.inject({ method: "POST", url: `/workspaces/${w.workspaceId}/ventures/${ideaId}/experiments/${experimentId}/launch`, cookies: { rid: w.cookie } });
    expect(launch.statusCode).toBe(200);
    expect(launch.json().status).toBe("live");

    // Capture 12 real (externally-attributed) visits via the funnel route.
    for (let i = 0; i < 12; i++) {
      const r = await app.inject({
        method: "POST",
        url: `/workspaces/${w.workspaceId}/ventures/${ideaId}/experiments/${experimentId}/signals`,
        cookies: { rid: w.cookie },
        payload: { signalClass: "visit", externalRef: `visitor-${i}` },
      });
      expect(r.statusCode).toBe(201);
    }

    // A funnel signal with no external attribution is refused (no circular/unattributed evidence).
    const noAttribution = await app.inject({
      method: "POST",
      url: `/workspaces/${w.workspaceId}/ventures/${ideaId}/experiments/${experimentId}/signals`,
      cookies: { rid: w.cookie },
      payload: { signalClass: "visit", externalRef: "  " },
    });
    expect(noAttribution.statusCode).toBe(400);

    // The apex signal: a real, signature-verified checkout flows through the #98 webhook → a paid signal.
    const evt = `evt_${newId()}`;
    expect((await fireWebhook(app, w, demandPaymentEvent(w.workspaceId, experimentId, 2500, evt))).statusCode).toBe(200);
    // Replay of the same Stripe event id is deduped — the funnel cannot double-count.
    expect((await fireWebhook(app, w, demandPaymentEvent(w.workspaceId, experimentId, 2500, evt))).statusCode).toBe(200);

    // The experiment view: funnel counts + a PASS against the LOCKED bar (1/12 = 8.3% ≥ 5%, sample 12 ≥ 10).
    const view = (await app.inject({ method: "GET", url: `/workspaces/${w.workspaceId}/ventures/${ideaId}/experiments/${experimentId}`, cookies: { rid: w.cookie } })).json();
    expect(view.funnel.counts.visit).toBe(12);
    expect(view.funnel.counts.paid).toBe(1); // deduped despite two deliveries
    expect(view.funnel.paidAmountCents).toBe(2500);
    expect(view.evaluation.status).toBe("PASS");

    // Re-score the idea: the demand dimension is now backed by REAL external evidence → the aggregate moves
    // above the synthetic baseline. With no external evidence it would be byte-for-byte the baseline.
    const after = await app.inject({ method: "POST", url: `/workspaces/${w.workspaceId}/ventures/${ideaId}/score`, cookies: { rid: w.cookie } });
    expect(after.statusCode).toBe(200);
    expect(after.json().score).toBeGreaterThan(baselineScore);
    expect(after.json().reasoning).toContain("external signal");
  });

  it("ETHICS: refuses to launch a pre-launch checkout without a disclosure, and auto-refunds a pre-availability charge", async () => {
    const { app } = await startApp();
    const w = await seed(app);
    const ideaId = await createIdea(app, w);

    // Register a waitlist (pre-launch) experiment with NO disclosure → launch is ethics-blocked (409).
    const reg = await app.inject({
      method: "POST",
      url: `/workspaces/${w.workspaceId}/ventures/${ideaId}/experiments`,
      cookies: { rid: w.cookie },
      payload: {
        hypothesis: "pre-orders validate demand",
        successClass: "paid",
        denominatorClass: "visit",
        passThreshold: 0.1,
        minSample: 5,
        windowStartMs: 0,
        windowEndMs: 1000,
        availability: "waitlist",
        // disclosure intentionally omitted
      },
    });
    expect(reg.statusCode).toBe(201);
    const experimentId = reg.json().id;
    const blocked = await app.inject({ method: "POST", url: `/workspaces/${w.workspaceId}/ventures/${ideaId}/experiments/${experimentId}/launch`, cookies: { rid: w.cookie } });
    expect(blocked.statusCode).toBe(409);

    // Register a preorder experiment WITH a disclosure and launch it.
    const reg2 = await app.inject({
      method: "POST",
      url: `/workspaces/${w.workspaceId}/ventures/${ideaId}/experiments`,
      cookies: { rid: w.cookie },
      payload: {
        hypothesis: "deposits validate demand",
        successClass: "paid",
        denominatorClass: "visit",
        passThreshold: 0.1,
        minSample: 5,
        windowStartMs: 0,
        windowEndMs: 1000,
        availability: "preorder",
        disclosure: "Pre-order — the product is not yet available; your card is a refundable deposit.",
      },
    });
    const eid2 = reg2.json().id;
    expect((await app.inject({ method: "POST", url: `/workspaces/${w.workspaceId}/ventures/${ideaId}/experiments/${eid2}/launch`, cookies: { rid: w.cookie } })).statusCode).toBe(200);

    // A real charge lands before availability → instant auto-refund + a recorded audit row.
    refundCalls.length = 0;
    const evt = `evt_${newId()}`;
    expect((await fireWebhook(app, w, demandPaymentEvent(w.workspaceId, eid2, 4000, evt))).statusCode).toBe(200);
    expect(refundCalls.map((c) => c.externalRef)).toContain(evt);
    const refundRows = await db.select().from(demandRefunds).where(eq(demandRefunds.experimentId, eid2));
    expect(refundRows).toHaveLength(1);
    expect(refundRows[0].amountCents).toBe(4000);

    // The paid signal is RETAINED (genuine demand evidence) — the refund is an ethics action, not erasure.
    const view = (await app.inject({ method: "GET", url: `/workspaces/${w.workspaceId}/ventures/${ideaId}/experiments/${eid2}`, cookies: { rid: w.cookie } })).json();
    expect(view.funnel.counts.paid).toBe(1);
  });

  it("rejects a malformed locked bar at registration (anti-p-hacking: the bar must be well-formed before launch)", async () => {
    const { app } = await startApp();
    const w = await seed(app);
    const ideaId = await createIdea(app, w);
    const res = await app.inject({
      method: "POST",
      url: `/workspaces/${w.workspaceId}/ventures/${ideaId}/experiments`,
      cookies: { rid: w.cookie },
      payload: {
        hypothesis: "bad bar",
        successClass: "paid",
        denominatorClass: "visit",
        passThreshold: 2, // > 1 — not a probability
        minSample: 10,
        windowStartMs: 0,
        windowEndMs: 1000,
        availability: "available",
      },
    });
    expect(res.statusCode).toBe(400);
  });
});
