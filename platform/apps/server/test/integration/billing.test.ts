import { describe, it, expect, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { AddressInfo } from "node:net";
import { WebSocket } from "ws";
import { buildApp } from "../../src/app.js";
import { db, closeDb } from "../../src/db/index.js";
import { closeRedis } from "../../src/redis/index.js";
import { firstCustomerStories, workspaces, revenueEvents } from "../../src/db/schema/index.js";
import { newId } from "../../src/db/id.js";
import { DeployManager } from "../../src/deploy/manager.js";
import { DryRunDeployProvider } from "../../src/deploy/dry-run-provider.js";
import { dbDeploymentStore } from "../../src/db/repositories/deployments.js";
import { BillingManager } from "../../src/billing/manager.js";
import { NoneBillingProvider } from "../../src/billing/none-provider.js";
import { dbBillingStore } from "../../src/db/repositories/billing.js";
import { signWebhookPayload } from "../../src/billing/webhook.js";
import { channelPoster } from "../../src/runtime/default.js";
import { StaticSecretsResolver } from "../../src/runtime/secrets-resolver.js";
import { CONFIG_DEFAULTS, type BillingConfig } from "../../src/config/schema.js";
import type { SessionLogger } from "../../src/runtime/manager.js";
import type { ServerEvent } from "../../src/realtime/protocol.js";

const silentLogger: SessionLogger = {
  child: () => silentLogger,
  info: () => {},
  warn: () => {},
  error: () => {},
};

const STRIPE_KEY = "sk-live-billing-secret-xyz";
const WHSEC = "whsec_integration_secret_abc";

const apps: FastifyInstance[] = [];
const slugs: string[] = [];

afterAll(async () => {
  for (const slug of slugs) await db.delete(workspaces).where(eq(workspaces.slug, slug));
  for (const app of apps) await app.close();
  await Promise.allSettled([closeDb(), closeRedis()]);
});

/** Build + listen an app whose Billing + Deploy managers use the no-network/no-spend providers. */
async function startApp(opts: { billing?: BillingConfig; dataPrivacyMode?: boolean } = {}): Promise<{
  app: FastifyInstance;
  ws: string;
}> {
  const loadConfig = () => ({
    ...CONFIG_DEFAULTS,
    dataPrivacyMode: opts.dataPrivacyMode ?? false,
    deploy: { provider: "dryrun" as const },
    billing: opts.billing,
  });
  const deployManager = new DeployManager({
    provider: new DryRunDeployProvider(),
    store: dbDeploymentStore,
    poster: channelPoster,
    provisioner: { prepare: () => Promise.resolve({ cwd: undefined }) },
    secrets: new StaticSecretsResolver({}),
    loadConfig,
    logger: silentLogger,
  });
  const billingManager = new BillingManager({
    provider: new NoneBillingProvider(),
    store: dbBillingStore,
    poster: channelPoster,
    secrets: new StaticSecretsResolver({
      STRIPE_SECRET_KEY: STRIPE_KEY,
      STRIPE_WEBHOOK_SECRET: WHSEC,
    }),
    deployments: {
      latestForSession: (sessionId, channelId) =>
        dbDeploymentStore.latestForSession(sessionId, channelId),
    },
    loadConfig,
    logger: silentLogger,
  });
  const app = buildApp({ deployManager, billingManager });
  apps.push(app);
  await app.listen({ port: 0, host: "127.0.0.1" });
  const { port } = app.server.address() as AddressInfo;
  return { app, ws: `ws://127.0.0.1:${port}/ws` };
}

interface World {
  cookie: string;
  workspaceId: string;
  channelId: string;
  agentMemberId: string;
}

async function seed(app: FastifyInstance): Promise<World> {
  const slug = `billing-${newId()}`;
  slugs.push(slug);
  const signup = await app.inject({
    method: "POST",
    url: "/auth/signup",
    payload: { email: `u-${newId()}@e.com`, password: "pw", displayName: "U", workspaceSlug: slug },
  });
  const cookie = signup.cookies.find((c) => c.name === "rid")!.value;
  const me = (await app.inject({ method: "GET", url: "/me", cookies: { rid: cookie } })).json();
  const channel = await app.inject({
    method: "POST",
    url: `/workspaces/${me.workspaceId}/channels`,
    cookies: { rid: cookie },
    payload: { name: "agents" },
  });
  const agent = await app.inject({
    method: "POST",
    url: `/workspaces/${me.workspaceId}/agents`,
    cookies: { rid: cookie },
    payload: { name: "Scout" },
  });
  return {
    cookie,
    workspaceId: me.workspaceId,
    channelId: channel.json().id,
    agentMemberId: agent.json().memberId,
  };
}

async function launchSession(app: FastifyInstance, w: World): Promise<string> {
  const res = await app.inject({
    method: "POST",
    url: `/channels/${w.channelId}/agent-sessions`,
    cookies: { rid: w.cookie },
    payload: { agentMemberId: w.agentMemberId, task: "build the app" },
  });
  expect(res.statusCode).toBe(202);
  return res.json().id as string;
}

async function deploy(app: FastifyInstance, w: World, sessionId: string): Promise<string> {
  const res = await app.inject({
    method: "POST",
    url: `/channels/${w.channelId}/agent-sessions/${sessionId}/deploy`,
    cookies: { rid: w.cookie },
  });
  expect(res.statusCode).toBe(202);
  return res.json().id as string;
}

async function subscribe(ws: string, w: World): Promise<{ events: ServerEvent[]; close: () => void }> {
  const socket = new WebSocket(ws, { headers: { cookie: `rid=${w.cookie}` } });
  const events: ServerEvent[] = [];
  await new Promise<void>((resolve, reject) => {
    socket.on("message", (data) => events.push(JSON.parse(data.toString()) as ServerEvent));
    socket.on("error", reject);
    socket.on("open", () => resolve());
  });
  await waitFor(events, (e) => e.type === "ready");
  socket.send(JSON.stringify({ type: "subscribe", channelId: w.channelId }));
  await waitFor(events, (e) => e.type === "subscribed");
  return { events, close: () => socket.terminate() };
}

function waitFor(events: ServerEvent[], match: (e: ServerEvent) => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const tick = (): void => {
      if (events.some(match)) return resolve();
      if (Date.now() > deadline) return reject(new Error("timeout waiting for event"));
      setTimeout(tick, 25);
    };
    tick();
  });
}

const BILLING_CFG: BillingConfig = { provider: "none", currency: "usd" };

/** A Stripe-shaped checkout.session.completed event, with the link metadata the manager round-trips. */
function paymentEvent(
  w: World,
  sessionId: string,
  leaked?: string,
  extraMeta: Record<string, string> = {},
): string {
  return JSON.stringify({
    id: `evt_${newId()}`,
    type: "checkout.session.completed",
    data: {
      object: {
        amount_total: 2500,
        currency: "usd",
        status: "complete",
        payment_status: "paid",
        metadata: {
          workspaceId: w.workspaceId,
          channelId: w.channelId,
          sessionId,
          agentMemberId: w.agentMemberId,
          ...(leaked ? { leaked } : {}),
          ...extraMeta,
        },
      },
    },
  });
}

describe("Stripe revenue rails (#98 — real Postgres + Redis, no-network none provider)", () => {
  it("mints a payment link for a deployed app, attaches it to the deployment, and posts it to the channel", async () => {
    const { app, ws } = await startApp({ billing: BILLING_CFG });
    const w = await seed(app);
    const sessionId = await launchSession(app, w);
    const deploymentId = await deploy(app, w, sessionId);
    const sub = await subscribe(ws, w);

    const res = await app.inject({
      method: "POST",
      url: `/channels/${w.channelId}/agent-sessions/${sessionId}/billing/payment-link`,
      cookies: { rid: w.cookie },
      payload: { name: "Pro plan", amountCents: 2500, currency: "usd", interval: "month" },
    });
    expect(res.statusCode).toBe(201);
    const link = res.json();
    expect(link.url).toMatch(/^https:\/\/.+/);
    expect(link.deploymentId).toBe(deploymentId); // attached to the deployment record
    expect(link.amountCents).toBe(2500);

    // The pay link was posted into the channel as a message (persisted, source of truth).
    await waitFor(sub.events, (e) => e.type === "message" && e.message.body.includes(link.url));
    await waitFor(sub.events, (e) => e.type === "billing_status" && e.kind === "link_created");
    sub.close();
  });

  it("ingests a signed webhook into a deduped revenue event + willingness-to-pay evidence and surfaces revenue", async () => {
    const { app, ws } = await startApp({ billing: BILLING_CFG });
    const w = await seed(app);
    const sessionId = await launchSession(app, w);
    const sub = await subscribe(ws, w);

    const raw = paymentEvent(w, sessionId, undefined, {
      customerJourney: "Customer found the demo, tried the launch flow, then paid.",
      quoteRequest: "Ask why the demo earned trust.",
    });
    const sig = signWebhookPayload(raw, WHSEC, Math.floor(Date.now() / 1000));
    const res = await app.inject({
      method: "POST",
      url: `/billing/webhook/${w.workspaceId}`,
      headers: { "content-type": "application/json", "stripe-signature": sig },
      payload: raw,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ received: true, deduped: false });

    // A "💰 Received" message + payment + first-customer celebration events reach the channel.
    await waitFor(sub.events, (e) => e.type === "message" && /received/i.test(e.message.body));
    await waitFor(sub.events, (e) => e.type === "billing_status" && e.kind === "payment_received");
    await waitFor(
      sub.events,
      (e) => e.type === "billing_status" && e.kind === "first_customer_won",
    );
    await waitFor(
      sub.events,
      (e) => e.type === "message" && /first paying customer/i.test(e.message.body),
    );

    const [story] = await db
      .select({
        caseStudyDraft: firstCustomerStories.caseStudyDraft,
        celebrationTitle: firstCustomerStories.celebrationTitle,
      })
      .from(firstCustomerStories)
      .where(eq(firstCustomerStories.workspaceId, w.workspaceId))
      .limit(1);
    expect(story?.celebrationTitle).toBe("First paying customer!");
    expect(story?.caseStudyDraft).toContain("Customer found the demo");
    expect(story?.caseStudyDraft).toContain("Ask why the demo earned trust");

    // Revenue per venture is surfaced for the #71 dashboard, with willingness-to-pay evidence counted.
    const revenue = (
      await app.inject({
        method: "GET",
        url: `/workspaces/${w.workspaceId}/billing/revenue`,
        cookies: { rid: w.cookie },
      })
    ).json();
    expect(revenue.totalCents).toBe(2500);
    expect(revenue.paymentCount).toBe(1);
    expect(revenue.evidenceCount).toBe(1);

    // A replayed delivery (same event id) is idempotent — no second row.
    const replay = await app.inject({
      method: "POST",
      url: `/billing/webhook/${w.workspaceId}`,
      headers: { "content-type": "application/json", "stripe-signature": sig },
      payload: raw,
    });
    expect(replay.statusCode).toBe(200);
    expect(replay.json().deduped).toBe(true);
    const after = (
      await app.inject({
        method: "GET",
        url: `/workspaces/${w.workspaceId}/billing/revenue`,
        cookies: { rid: w.cookie },
      })
    ).json();
    expect(after.paymentCount).toBe(1); // still one
    sub.close();
  });

  it("rejects a webhook with a bad signature (no event persisted)", async () => {
    const { app } = await startApp({ billing: BILLING_CFG });
    const w = await seed(app);
    const sessionId = await launchSession(app, w);
    const raw = paymentEvent(w, sessionId);
    const res = await app.inject({
      method: "POST",
      url: `/billing/webhook/${w.workspaceId}`,
      headers: { "content-type": "application/json", "stripe-signature": "t=1,v1=deadbeef" },
      payload: raw,
    });
    expect(res.statusCode).toBe(400);
    const revenue = (
      await app.inject({
        method: "GET",
        url: `/workspaces/${w.workspaceId}/billing/revenue`,
        cookies: { rid: w.cookie },
      })
    ).json();
    expect(revenue.paymentCount).toBe(0);
  });

  it("never persists a secret value that leaked into the webhook payload (raw is redacted)", async () => {
    const { app } = await startApp({ billing: BILLING_CFG });
    const w = await seed(app);
    const sessionId = await launchSession(app, w);
    const raw = paymentEvent(w, sessionId, STRIPE_KEY);
    const sig = signWebhookPayload(raw, WHSEC, Math.floor(Date.now() / 1000));
    await app.inject({
      method: "POST",
      url: `/billing/webhook/${w.workspaceId}`,
      headers: { "content-type": "application/json", "stripe-signature": sig },
      payload: raw,
    });
    const [row] = await db
      .select({ raw: revenueEvents.raw })
      .from(revenueEvents)
      .where(eq(revenueEvents.workspaceId, w.workspaceId))
      .limit(1);
    expect(JSON.stringify(row?.raw)).not.toContain(STRIPE_KEY);
    expect(JSON.stringify(row?.raw)).toContain("‹redacted›");
  });

  it("returns 409 when the tenant has not enabled billing (opt-in)", async () => {
    const { app } = await startApp({}); // no billing config
    const w = await seed(app);
    const sessionId = await launchSession(app, w);
    const res = await app.inject({
      method: "POST",
      url: `/channels/${w.channelId}/agent-sessions/${sessionId}/billing/payment-link`,
      cookies: { rid: w.cookie },
      payload: { name: "Pro plan", amountCents: 2500 },
    });
    expect(res.statusCode).toBe(409);
  });

  it("returns 409 when data-privacy mode forbids off-platform egress", async () => {
    const { app } = await startApp({ billing: BILLING_CFG, dataPrivacyMode: true });
    const w = await seed(app);
    const sessionId = await launchSession(app, w);
    const res = await app.inject({
      method: "POST",
      url: `/channels/${w.channelId}/agent-sessions/${sessionId}/billing/payment-link`,
      cookies: { rid: w.cookie },
      payload: { name: "Pro plan", amountCents: 2500 },
    });
    expect(res.statusCode).toBe(409);
  });

  it("cannot mint a payment link across a channel/workspace boundary (IDOR)", async () => {
    const { app } = await startApp({ billing: BILLING_CFG });
    const a = await seed(app);
    const b = await seed(app);
    const sessionId = await launchSession(app, a);
    const res = await app.inject({
      method: "POST",
      url: `/channels/${a.channelId}/agent-sessions/${sessionId}/billing/payment-link`, // A's channel
      cookies: { rid: b.cookie }, // B's identity
      payload: { name: "Pro plan", amountCents: 2500 },
    });
    expect(res.statusCode).toBe(404); // A's channel is invisible to B
  });
});
