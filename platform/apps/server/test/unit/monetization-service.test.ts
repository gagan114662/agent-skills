import { describe, it, expect } from "vitest";
import { newId } from "../../src/db/id.js";
import {
  MonetizationService,
  MonetizationDisabledError,
  VentureStripeNotConnectedError,
  type MonetizationStore,
  type MoneyDecisionGate,
  type VentureStripeResolver,
  type PlanRecord,
  type ExperimentRecord,
  type RevenueRecord,
} from "../../src/monetization/service.js";
import { MonetizationEngine } from "../../src/monetization/engine.js";
import { MONETIZATION_DEFAULTS, type MonetizationCaps } from "../../src/monetization/caps.js";
import { evaluatePolicy, MONETIZATION_ACTIVATE_PRICE_ACTION } from "../../src/approvals/policy.js";
import type { ApprovalStatus } from "../../src/approvals/policy.js";
import type { BillingProvider } from "../../src/billing/provider.js";
import { signWebhookPayload } from "../../src/billing/webhook.js";
import { WebhookVerificationError } from "../../src/billing/webhook.js";

/** In-memory store mirroring the repo's idempotency on (workspace, providerEventId). */
class MemoryStore implements MonetizationStore {
  plans: PlanRecord[] = [];
  experiments: ExperimentRecord[] = [];
  revenue: RevenueRecord[] = [];

  async createPlan(input: Parameters<MonetizationStore["createPlan"]>[0]): Promise<PlanRecord> {
    const plan: PlanRecord = {
      id: newId(),
      workspaceId: input.workspaceId,
      ventureIdeaId: input.ventureIdeaId,
      name: input.name,
      amountCents: input.amountCents,
      currency: input.currency,
      interval: input.interval,
      status: "draft",
      provider: null,
      productId: null,
      priceId: null,
      providerLinkId: null,
      url: null,
      activationRequestId: null,
      previousAmountCents: null,
    };
    this.plans.push(plan);
    return plan;
  }
  async getPlan(workspaceId: string, id: string): Promise<PlanRecord | undefined> {
    return this.plans.find((p) => p.workspaceId === workspaceId && p.id === id);
  }
  async listPlans(
    workspaceId: string,
    filter?: { ventureIdeaId?: string | null; status?: PlanRecord["status"]; limit?: number },
  ): Promise<PlanRecord[]> {
    let rows = this.plans.filter((p) => p.workspaceId === workspaceId);
    if (filter?.ventureIdeaId === null) rows = rows.filter((p) => p.ventureIdeaId === null);
    else if (typeof filter?.ventureIdeaId === "string") rows = rows.filter((p) => p.ventureIdeaId === filter.ventureIdeaId);
    if (filter?.status) rows = rows.filter((p) => p.status === filter.status);
    return filter?.limit ? rows.slice(0, filter.limit) : rows;
  }
  async updatePlan(
    workspaceId: string,
    id: string,
    patch: Partial<PlanRecord> & { activatedAtMs?: number | null },
  ): Promise<PlanRecord | undefined> {
    const plan = this.plans.find((p) => p.workspaceId === workspaceId && p.id === id);
    if (!plan) return undefined;
    for (const [k, v] of Object.entries(patch)) {
      if (k === "activatedAtMs") continue; // not a PlanRecord field in the in-memory fake
      (plan as Record<string, unknown>)[k] = v;
    }
    return plan;
  }

  async createExperiment(input: Parameters<MonetizationStore["createExperiment"]>[0]): Promise<ExperimentRecord> {
    const exp: ExperimentRecord = {
      id: newId(),
      workspaceId: input.workspaceId,
      ventureIdeaId: input.ventureIdeaId,
      planId: input.planId,
      hypothesis: input.hypothesis,
      baselineAmountCents: input.baselineAmountCents,
      candidateAmountCents: input.candidateAmountCents,
      baselineRevenueCents: input.baselineRevenueCents,
      projectedDeltaCents: input.projectedDeltaCents,
      status: "proposed",
      activationRequestId: null,
      verifiedRevenueCents: null,
      realizedDeltaCents: null,
    };
    this.experiments.push(exp);
    return exp;
  }
  async getExperiment(workspaceId: string, id: string): Promise<ExperimentRecord | undefined> {
    return this.experiments.find((e) => e.workspaceId === workspaceId && e.id === id);
  }
  async listExperiments(
    workspaceId: string,
    filter?: { ventureIdeaId?: string | null; limit?: number },
  ): Promise<ExperimentRecord[]> {
    let rows = this.experiments.filter((e) => e.workspaceId === workspaceId);
    if (typeof filter?.ventureIdeaId === "string") rows = rows.filter((e) => e.ventureIdeaId === filter.ventureIdeaId);
    return filter?.limit ? rows.slice(0, filter.limit) : rows;
  }
  async updateExperiment(
    workspaceId: string,
    id: string,
    patch: Partial<ExperimentRecord> & { concludedAtMs?: number | null },
  ): Promise<ExperimentRecord | undefined> {
    const exp = this.experiments.find((e) => e.workspaceId === workspaceId && e.id === id);
    if (!exp) return undefined;
    for (const [k, v] of Object.entries(patch)) {
      if (k === "concludedAtMs") continue; // not an ExperimentRecord field in the in-memory fake
      (exp as Record<string, unknown>)[k] = v;
    }
    return exp;
  }

  async recordRevenue(
    input: Parameters<MonetizationStore["recordRevenue"]>[0],
  ): Promise<{ deduped: boolean; revenue: RevenueRecord }> {
    const existing = this.revenue.find(
      (r) => r.workspaceId === input.workspaceId && r.providerEventId === input.providerEventId,
    );
    if (existing) return { deduped: true, revenue: existing };
    const revenue: RevenueRecord = {
      id: newId(),
      workspaceId: input.workspaceId,
      ventureIdeaId: input.ventureIdeaId,
      providerEventId: input.providerEventId,
      amountCents: input.amountCents,
      currency: input.currency,
      occurredAtMs: input.occurredAtMs,
    };
    this.revenue.push(revenue);
    return { deduped: false, revenue };
  }
  async sumVentureRevenue(workspaceId: string, ventureIdeaId: string, sinceMs?: number): Promise<number> {
    return this.revenue
      .filter(
        (r) =>
          r.workspaceId === workspaceId &&
          r.ventureIdeaId === ventureIdeaId &&
          (sinceMs === undefined || r.occurredAtMs > sinceMs),
      )
      .reduce((a, r) => a + r.amountCents, 0);
  }
}

/** A vault that records the connect call + lets a test toggle connection state. */
class MemoryVault implements VentureStripeResolver {
  connected = new Map<string, Record<string, string>>();
  async isConnected(workspaceId: string, ventureIdeaId: string): Promise<boolean> {
    return this.connected.has(`${workspaceId}|${ventureIdeaId}`);
  }
  async resolve(workspaceId: string, ventureIdeaId: string): Promise<Record<string, string>> {
    return this.connected.get(`${workspaceId}|${ventureIdeaId}`) ?? {};
  }
  async connect(input: {
    workspaceId: string;
    ventureIdeaId: string;
    secrets: Record<string, string>;
  }): Promise<void> {
    this.connected.set(`${input.workspaceId}|${input.ventureIdeaId}`, input.secrets);
  }
}

/** A gate that records submissions and lets a test flip a request to `executed` (the owner approved). */
class MemoryGate implements MoneyDecisionGate {
  submitted: Array<{ id: string; actionKind: string; summary: string; amountCents: number | null; payload: Record<string, unknown> }> = [];
  statuses = new Map<string, ApprovalStatus>();
  async submit(input: {
    actionKind: string;
    summary: string;
    amountCents?: number | null;
    payload: Record<string, unknown>;
  }): Promise<{ id: string }> {
    const id = newId();
    this.submitted.push({
      id,
      actionKind: input.actionKind,
      summary: input.summary,
      amountCents: input.amountCents ?? null,
      payload: input.payload,
    });
    this.statuses.set(id, "pending");
    return { id };
  }
  async status(id: string): Promise<ApprovalStatus | undefined> {
    return this.statuses.get(id);
  }
  approve(id: string): void {
    this.statuses.set(id, "executed");
  }
}

/** A fake inbound-only provider that records secrets it was handed and mints deterministic ids. */
class FakeProvider implements BillingProvider {
  readonly kind = "stripe";
  seenSecrets: Array<Record<string, string>> = [];
  async createProductPrice(input: { secrets: Record<string, string> }): Promise<{ productId: string; priceId: string }> {
    this.seenSecrets.push(input.secrets);
    return { productId: "prod_x", priceId: "price_x" };
  }
  async createPaymentLink(input: { secrets: Record<string, string> }): Promise<{ providerLinkId: string; url: string }> {
    this.seenSecrets.push(input.secrets);
    return { providerLinkId: "plink_x", url: "https://pay.example/x" };
  }
}

const WS = "ws-mon";
const VENTURE = "venture-1";
const AGENT = "agent-member";
const NOW = new Date("2026-06-14T00:00:00Z");

function build(opts?: {
  caps?: Partial<MonetizationCaps>;
  ownerWorkspaceId?: (wid: string) => Promise<string | null>;
}): {
  service: MonetizationService;
  store: MemoryStore;
  vault: MemoryVault;
  gate: MemoryGate;
  provider: FakeProvider;
} {
  const store = new MemoryStore();
  const vault = new MemoryVault();
  const gate = new MemoryGate();
  const provider = new FakeProvider();
  const service = new MonetizationService({
    store,
    vault,
    gate,
    billing: provider,
    caps: () => ({ ...MONETIZATION_DEFAULTS, enabled: true, ...opts?.caps }),
    ownerWorkspaceId: opts?.ownerWorkspaceId,
    now: () => NOW,
  });
  return { service, store, vault, gate, provider };
}

describe("MonetizationService — default OFF", () => {
  it("refuses every step when monetization is disabled", async () => {
    const { service } = build({ caps: { enabled: false } });
    await expect(
      service.draftPlan({ workspaceId: WS, ventureIdeaId: VENTURE, name: "Pro", amountCents: 2500 }),
    ).rejects.toBeInstanceOf(MonetizationDisabledError);
  });

  it("refuses a non-owner workspace when ownerWorkspaceOnly is set", async () => {
    const { service } = build({
      caps: { ownerWorkspaceOnly: true },
      ownerWorkspaceId: async () => "some-other-owner",
    });
    await expect(
      service.draftPlan({ workspaceId: WS, ventureIdeaId: VENTURE, name: "Pro", amountCents: 2500 }),
    ).rejects.toBeInstanceOf(MonetizationDisabledError);
  });
});

describe("MonetizationService — drafting (reversible, free)", () => {
  it("drafts a plan with status=draft and no Stripe/gate side effects", async () => {
    const { service, gate, provider } = build();
    const plan = await service.draftPlan({
      workspaceId: WS,
      ventureIdeaId: VENTURE,
      name: "Pro",
      amountCents: 2500,
      interval: "month",
    });
    expect(plan.status).toBe("draft");
    expect(plan.currency).toBe("usd");
    expect(gate.submitted).toHaveLength(0); // no money decision for a draft
    expect(provider.seenSecrets).toHaveLength(0); // no Stripe call for a draft
  });

  it("rejects an invalid draft via the pure validator", async () => {
    const { service } = build();
    await expect(
      service.draftPlan({ workspaceId: WS, ventureIdeaId: VENTURE, name: "", amountCents: 2500 }),
    ).rejects.toBeInstanceOf(MonetizationDisabledError);
  });
});

describe("MonetizationService — activation money boundary", () => {
  it("requires the venture to connect its own Stripe account first", async () => {
    const { service, store } = build();
    const plan = await store.createPlan({
      workspaceId: WS,
      ventureIdeaId: VENTURE,
      name: "Pro",
      amountCents: 2500,
      currency: "usd",
      interval: "month",
      createdByMemberId: null,
    });
    await expect(
      service.requestActivation({ workspaceId: WS, planId: plan.id, requesterMemberId: AGENT, ventureName: "Acme" }),
    ).rejects.toBeInstanceOf(VentureStripeNotConnectedError);
  });

  it("parks a MONEY decision with the exact amount and the activate action kind", async () => {
    const { service, gate, vault } = build();
    await vault.connect({ workspaceId: WS, ventureIdeaId: VENTURE, secrets: { STRIPE_SECRET_KEY: "sk_test_venture" } });
    const plan = await service.draftPlan({ workspaceId: WS, ventureIdeaId: VENTURE, name: "Pro", amountCents: 2500, interval: "month" });

    const { approvalRequestId } = await service.requestActivation({
      workspaceId: WS,
      planId: plan.id,
      requesterMemberId: AGENT,
      ventureName: "Acme",
    });

    expect(gate.submitted).toHaveLength(1);
    const req = gate.submitted[0]!;
    expect(req.id).toBe(approvalRequestId);
    expect(req.actionKind).toBe(MONETIZATION_ACTIVATE_PRICE_ACTION);
    expect(req.amountCents).toBe(2500); // exact amount drives the gate + shows on the card
    expect(req.summary).toContain("$25.00/month");
    // the plan is parked pending the owner's decision — NOT yet active
    const parked = await service.listPlans(WS, VENTURE);
    expect(parked[0]!.status).toBe("pending_activation");
    expect(parked[0]!.activationRequestId).toBe(approvalRequestId);
  });

  it("the activate action is sensitive-by-default in the #13 policy (gated with no rule)", () => {
    expect(evaluatePolicy({ actionType: MONETIZATION_ACTIVATE_PRICE_ACTION }, []).requiresApproval).toBe(true);
  });
});

describe("MonetizationService — minting after approval (the engine tick)", () => {
  it("mints a real link with the venture's OWN key only after the owner approves", async () => {
    const { service, gate, vault, provider } = build();
    await vault.connect({
      workspaceId: WS,
      ventureIdeaId: VENTURE,
      secrets: { STRIPE_SECRET_KEY: "sk_test_venture", STRIPE_WEBHOOK_SECRET: "whsec_v" },
    });
    const plan = await service.draftPlan({ workspaceId: WS, ventureIdeaId: VENTURE, name: "Pro", amountCents: 2500, interval: "month" });
    const { approvalRequestId } = await service.requestActivation({
      workspaceId: WS,
      planId: plan.id,
      requesterMemberId: AGENT,
      ventureName: "Acme",
    });

    // Before approval: the engine mints nothing.
    let res = await service.activatePending(WS);
    expect(res.activated).toHaveLength(0);
    expect(provider.seenSecrets).toHaveLength(0);

    // Owner approves in the #13 queue → the engine mints the live link with the venture's own key.
    gate.approve(approvalRequestId);
    res = await service.activatePending(WS);
    expect(res.activated).toEqual([plan.id]);
    expect(provider.seenSecrets[0]).toEqual({ STRIPE_SECRET_KEY: "sk_test_venture", STRIPE_WEBHOOK_SECRET: "whsec_v" });

    const [active] = await service.listPlans(WS, VENTURE);
    expect(active!.status).toBe("active");
    expect(active!.url).toBe("https://pay.example/x");
    expect(active!.priceId).toBe("price_x");

    // Idempotent: a second tick does not re-mint.
    res = await service.activatePending(WS);
    expect(res.activated).toHaveLength(0);
  });

  it("does not mint while the request is still pending", async () => {
    const { service, vault, provider } = build();
    await vault.connect({ workspaceId: WS, ventureIdeaId: VENTURE, secrets: { STRIPE_SECRET_KEY: "sk" } });
    const plan = await service.draftPlan({ workspaceId: WS, ventureIdeaId: VENTURE, name: "Pro", amountCents: 2500 });
    await service.requestActivation({ workspaceId: WS, planId: plan.id, requesterMemberId: AGENT, ventureName: "Acme" });
    const res = await service.activatePending(WS);
    expect(res.activated).toHaveLength(0);
    expect(provider.seenSecrets).toHaveLength(0);
  });
});

describe("MonetizationService — experiments (#188 AC3)", () => {
  it("proposes an experiment storing an UNVERIFIED projection", async () => {
    const { service } = build();
    const { experiment, projection } = await service.proposeExperiment({
      workspaceId: WS,
      ventureIdeaId: VENTURE,
      hypothesis: "raising price lifts revenue",
      baselineAmountCents: 2000,
      candidateAmountCents: 2500,
      baselineConversions: 100,
      candidateConversions: 90,
    });
    expect(projection.estimateLabel).toBe("UNVERIFIED");
    expect(experiment.status).toBe("proposed");
    expect(experiment.projectedDeltaCents).toBe(25_000);
  });

  it("concludes from EXTERNALLY-VERIFIED revenue only, not the projection", async () => {
    const { service, store } = build();
    const { experiment } = await service.proposeExperiment({
      workspaceId: WS,
      ventureIdeaId: VENTURE,
      hypothesis: "h",
      baselineAmountCents: 2000,
      candidateAmountCents: 2500,
      baselineConversions: 100,
      candidateConversions: 90,
    });
    // Two verified receipts for the venture totalling $230.00.
    await store.recordRevenue({
      workspaceId: WS,
      ventureIdeaId: VENTURE,
      providerEventId: "evt_1",
      type: "charge.succeeded",
      amountCents: 200_000,
      currency: "usd",
      status: "succeeded",
      raw: "{}",
      occurredAtMs: NOW.getTime(),
    });
    await store.recordRevenue({
      workspaceId: WS,
      ventureIdeaId: VENTURE,
      providerEventId: "evt_2",
      type: "charge.succeeded",
      amountCents: 30_000,
      currency: "usd",
      status: "succeeded",
      raw: "{}",
      occurredAtMs: NOW.getTime(),
    });
    const result = await service.concludeExperiment({ workspaceId: WS, experimentId: experiment.id });
    expect(result.verifiedRevenueCents).toBe(230_000);
    // baseline revenue at proposal = $20 × 100 = $2000.00 → realized lift = 230000 − 200000 = 30000
    expect(result.realizedDeltaCents).toBe(30_000);
    const [stored] = await service.listExperiments(WS, VENTURE);
    expect(stored!.status).toBe("concluded");
    expect(stored!.verifiedRevenueCents).toBe(230_000);
  });
});

describe("MonetizationService — payout settings + refunds", () => {
  it("parks payout settings as a recorded-only money decision", async () => {
    const { service, gate } = build();
    const { approvalRequestId } = await service.requestPayoutSettings({
      workspaceId: WS,
      ventureId: VENTURE,
      ventureName: "Acme",
      destination: "acct_999",
      requesterMemberId: AGENT,
    });
    expect(gate.submitted).toHaveLength(1);
    expect(gate.submitted[0]!.actionKind).toBe("monetization.payout_settings");
    expect(gate.submitted[0]!.id).toBe(approvalRequestId);
  });
});

describe("MonetizationService — per-venture webhook ingestion (#188 AC4)", () => {
  const body = JSON.stringify({
    id: "evt_pay_1",
    type: "checkout.session.completed",
    data: { object: { amount_total: 2500, currency: "usd", payment_status: "paid" } },
  });

  it("rejects a forged/unsigned delivery", async () => {
    const { service, vault } = build();
    await vault.connect({ workspaceId: WS, ventureIdeaId: VENTURE, secrets: { STRIPE_WEBHOOK_SECRET: "whsec_v" } });
    await expect(
      service.ingestVentureWebhook({ workspaceId: WS, ventureIdeaId: VENTURE, rawBody: body, signature: "bogus" }),
    ).rejects.toBeInstanceOf(WebhookVerificationError);
  });

  it("records a verified venture-attributed receipt and dedupes a replay", async () => {
    const { service, store, vault } = build();
    await vault.connect({ workspaceId: WS, ventureIdeaId: VENTURE, secrets: { STRIPE_WEBHOOK_SECRET: "whsec_v" } });
    const ts = Math.floor(NOW.getTime() / 1000);
    const sig = signWebhookPayload(body, "whsec_v", ts);

    const first = await service.ingestVentureWebhook({ workspaceId: WS, ventureIdeaId: VENTURE, rawBody: body, signature: sig });
    expect(first.deduped).toBe(false);
    expect(first.revenue?.amountCents).toBe(2500);
    expect(first.revenue?.ventureIdeaId).toBe(VENTURE);
    expect(store.revenue).toHaveLength(1);

    const replay = await service.ingestVentureWebhook({ workspaceId: WS, ventureIdeaId: VENTURE, rawBody: body, signature: sig });
    expect(replay.deduped).toBe(true);
    expect(store.revenue).toHaveLength(1); // no double count
  });

  it("requires the venture's webhook secret (not connected ⇒ refuse)", async () => {
    const { service } = build();
    await expect(
      service.ingestVentureWebhook({ workspaceId: WS, ventureIdeaId: VENTURE, rawBody: body, signature: "x" }),
    ).rejects.toBeInstanceOf(VentureStripeNotConnectedError);
  });
});

describe("MonetizationEngine", () => {
  it("is a no-op for a disabled workspace", async () => {
    const store = new MemoryStore();
    const service = new MonetizationService({
      store,
      vault: new MemoryVault(),
      gate: new MemoryGate(),
      billing: new FakeProvider(),
      caps: () => ({ ...MONETIZATION_DEFAULTS, enabled: false }),
      now: () => NOW,
    });
    const engine = new MonetizationEngine({
      service,
      listWorkspaceIds: async () => [WS],
      caps: () => ({ ...MONETIZATION_DEFAULTS, enabled: false }),
      logger: { child: () => ({}) as never, info: () => {}, warn: () => {}, error: () => {} },
    });
    const res = await engine.tickWorkspace(WS);
    expect(res.activated).toBe(0);
  });

  it("activates approved plans on a tick", async () => {
    const { service, gate, vault } = build();
    await vault.connect({ workspaceId: WS, ventureIdeaId: VENTURE, secrets: { STRIPE_SECRET_KEY: "sk" } });
    const plan = await service.draftPlan({ workspaceId: WS, ventureIdeaId: VENTURE, name: "Pro", amountCents: 2500 });
    const { approvalRequestId } = await service.requestActivation({
      workspaceId: WS,
      planId: plan.id,
      requesterMemberId: AGENT,
      ventureName: "Acme",
    });
    gate.approve(approvalRequestId);
    const engine = new MonetizationEngine({
      service,
      listWorkspaceIds: async () => [WS],
      caps: () => ({ ...MONETIZATION_DEFAULTS, enabled: true }),
      logger: { child: () => ({}) as never, info: () => {}, warn: () => {}, error: () => {} },
    });
    const res = await engine.tickWorkspace(WS);
    expect(res.activated).toBe(1);
  });
});
