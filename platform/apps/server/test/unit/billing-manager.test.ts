import { describe, it, expect, beforeEach } from "vitest";
import {
  BillingManager,
  BillingEgressBlocked,
  NoBillingConfigError,
  BillingProviderError,
  type BillingStore,
  type PaymentLink,
  type RevenueEvent,
  type RevenueEvidence,
  type RevenueSummary,
  type CreatePaymentLinkRow,
  type CreateRevenueEventRow,
  type CreateEvidenceRow,
} from "../../src/billing/manager.js";
import { WebhookVerificationError, signWebhookPayload } from "../../src/billing/webhook.js";
import { NoneBillingProvider } from "../../src/billing/none-provider.js";
import { StaticSecretsResolver } from "../../src/runtime/secrets-resolver.js";
import { CONFIG_DEFAULTS, type ResolvedConfig } from "../../src/config/schema.js";
import type { ChannelPoster } from "../../src/runtime/manager.js";
import type { BillingStatusEvent } from "../../src/realtime/protocol.js";

/** A hermetic in-memory billing store — stands in for Postgres (no DB). */
class MemoryBillingStore implements BillingStore {
  links: PaymentLink[] = [];
  events: RevenueEvent[] = [];
  evidence: RevenueEvidence[] = [];
  private seq = 0;

  createPaymentLink(input: CreatePaymentLinkRow): Promise<PaymentLink> {
    const row: PaymentLink = {
      id: `pl_${++this.seq}`,
      createdAt: new Date(),
      ...input,
    };
    this.links.push(row);
    return Promise.resolve({ ...row });
  }
  findRevenueEvent(workspaceId: string, providerEventId: string): Promise<RevenueEvent | undefined> {
    const row = this.events.find(
      (e) => e.workspaceId === workspaceId && e.providerEventId === providerEventId,
    );
    return Promise.resolve(row ? { ...row } : undefined);
  }
  createRevenueEvent(input: CreateRevenueEventRow): Promise<RevenueEvent> {
    const row: RevenueEvent = { id: `re_${++this.seq}`, createdAt: new Date(), ...input };
    this.events.push(row);
    return Promise.resolve({ ...row });
  }
  createEvidence(input: CreateEvidenceRow): Promise<RevenueEvidence> {
    const row: RevenueEvidence = { id: `ev_${++this.seq}`, createdAt: new Date(), ...input };
    this.evidence.push(row);
    return Promise.resolve({ ...row });
  }
  revenueSummary(workspaceId: string): Promise<RevenueSummary> {
    const events = this.events.filter((e) => e.workspaceId === workspaceId);
    return Promise.resolve({
      currency: events[0]?.currency ?? "usd",
      totalCents: events.reduce((s, e) => s + e.amountCents, 0),
      paymentCount: events.length,
      evidenceCount: this.evidence.filter((e) => e.workspaceId === workspaceId).length,
      recent: events.slice(-10).reverse(),
    });
  }
}

const SECRET = "sk-live-supersecret-billing-123";
const WHSEC = "whsec_supersecret_webhook_999";
const NOW = new Date("2026-06-10T00:00:00.000Z");
const NOW_SEC = Math.floor(NOW.getTime() / 1000);

interface Harness {
  manager: BillingManager;
  store: MemoryBillingStore;
  provider: NoneBillingProvider;
  events: BillingStatusEvent[];
  posts: string[];
}

function makeHarness(cfg: Partial<ResolvedConfig> = {}): Harness {
  const store = new MemoryBillingStore();
  const provider = new NoneBillingProvider();
  const events: BillingStatusEvent[] = [];
  const posts: string[] = [];
  const poster: ChannelPoster = {
    post: (input) => {
      posts.push(input.body);
      return Promise.resolve({ id: "msg_1" });
    },
  };
  const manager = new BillingManager({
    provider,
    store,
    poster,
    secrets: new StaticSecretsResolver({ STRIPE_SECRET_KEY: SECRET, STRIPE_WEBHOOK_SECRET: WHSEC }),
    loadConfig: () => ({
      ...CONFIG_DEFAULTS,
      billing: { provider: "none", currency: "usd" },
      ...cfg,
    }),
    deployments: { latestForSession: () => Promise.resolve({ id: "dep_1" }) },
    publish: (_cid, event) => events.push(event),
    now: () => NOW,
    toleranceSec: 300,
  });
  return { manager, store, provider, events, posts };
}

const LINK_REQ = {
  sessionId: "sess_1",
  workspaceId: "ws_1",
  channelId: "chan_1",
  agentMemberId: "agent_1",
  createdByMemberId: "human_1",
  name: "Pro plan",
  amountCents: 2500,
  currency: "usd",
  interval: "month" as const,
};

function successEvent(extraMeta: Record<string, string> = {}): string {
  return JSON.stringify({
    id: "evt_pay_1",
    type: "checkout.session.completed",
    data: {
      object: {
        amount_total: 2500,
        currency: "usd",
        status: "complete",
        payment_status: "paid",
        metadata: {
          workspaceId: "ws_1",
          channelId: "chan_1",
          sessionId: "sess_1",
          agentMemberId: "agent_1",
          ...extraMeta,
        },
      },
    },
  });
}

describe("BillingManager (#98 — inbound payment link + signed webhook → revenue → evidence)", () => {
  let h: Harness;
  beforeEach(() => {
    h = makeHarness();
  });

  it("creates a payment link, attaches it to the session's deployment, and posts it to the channel", async () => {
    const link = await h.manager.createPaymentLink(LINK_REQ);
    expect(link.url).toMatch(/^https:\/\/.+/);
    expect(link.deploymentId).toBe("dep_1"); // attached to the deployment record
    expect(link.amountCents).toBe(2500);
    expect(h.posts.some((b) => b.includes(link.url))).toBe(true);
    expect(h.events.some((e) => e.kind === "link_created")).toBe(true);
    expect(h.provider.products.length).toBe(1); // product+price created via the provider
    expect(h.provider.links.length).toBe(1);
  });

  it("redacts a secret from a provider error (never leaks the key)", async () => {
    h.provider.failNext = `stripe auth failed using ${SECRET}`;
    const err = await h.manager.createPaymentLink(LINK_REQ).catch((e) => e as Error);
    expect(err).toBeInstanceOf(BillingProviderError);
    expect(err.message).not.toContain(SECRET);
    expect(err.message).toContain("‹redacted›");
  });

  it("refuses to create a payment link under data-privacy mode (off-platform egress gate)", async () => {
    const priv = makeHarness({ dataPrivacyMode: true });
    await expect(priv.manager.createPaymentLink(LINK_REQ)).rejects.toBeInstanceOf(BillingEgressBlocked);
    expect(priv.provider.products.length).toBe(0); // never called the provider
  });

  it("throws when the tenant has not enabled billing (opt-in)", async () => {
    const none = makeHarness({ billing: undefined });
    await expect(none.manager.createPaymentLink(LINK_REQ)).rejects.toBeInstanceOf(NoBillingConfigError);
  });

  it("ingests a signed webhook into a revenue event AND willingness-to-pay evidence, posting to the channel", async () => {
    const raw = successEvent();
    const sig = signWebhookPayload(raw, WHSEC, NOW_SEC);
    const res = await h.manager.ingestWebhook("ws_1", raw, sig);

    expect(res.deduped).toBe(false);
    expect(res.event?.amountCents).toBe(2500);
    expect(h.store.events.length).toBe(1);
    // A real payment becomes willingness-to-pay evidence the venture scorecard (#96) consumes.
    expect(h.store.evidence.length).toBe(1);
    expect(h.store.evidence[0]?.kind).toBe("willingness_to_pay");
    expect(h.store.evidence[0]?.source).toBe("revenue");
    expect(h.posts.some((b) => /received/i.test(b))).toBe(true);
    expect(h.events.some((e) => e.kind === "payment_received")).toBe(true);
  });

  it("dedupes a replayed webhook (same event id) — at most one revenue event", async () => {
    const raw = successEvent();
    const sig = signWebhookPayload(raw, WHSEC, NOW_SEC);
    await h.manager.ingestWebhook("ws_1", raw, sig);
    const second = await h.manager.ingestWebhook("ws_1", raw, sig);
    expect(second.deduped).toBe(true);
    expect(h.store.events.length).toBe(1); // no second row
    expect(h.store.evidence.length).toBe(1); // no second evidence row
  });

  it("rejects a webhook with a bad signature (no row persisted)", async () => {
    const raw = successEvent();
    await expect(
      h.manager.ingestWebhook("ws_1", raw, "t=" + NOW_SEC + ",v1=deadbeef"),
    ).rejects.toBeInstanceOf(WebhookVerificationError);
    expect(h.store.events.length).toBe(0);
  });

  it("redacts a secret value that leaked into the webhook payload before persisting raw", async () => {
    const raw = successEvent({ leaked: SECRET });
    const sig = signWebhookPayload(raw, WHSEC, NOW_SEC);
    const res = await h.manager.ingestWebhook("ws_1", raw, sig);
    expect(res.event?.raw).not.toContain(SECRET);
    expect(res.event?.raw).toContain("‹redacted›");
  });

  it("does not create evidence for a non-payment event", async () => {
    const raw = JSON.stringify({
      id: "evt_other_1",
      type: "payment_intent.created",
      data: { object: { amount: 2500, currency: "usd", metadata: {} } },
    });
    const sig = signWebhookPayload(raw, WHSEC, NOW_SEC);
    await h.manager.ingestWebhook("ws_1", raw, sig);
    expect(h.store.events.length).toBe(1); // still recorded...
    expect(h.store.evidence.length).toBe(0); // ...but not willingness-to-pay evidence
  });
});
