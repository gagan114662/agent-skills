import { describe, it, expect } from "vitest";
import { NoneBillingProvider } from "../../src/billing/none-provider.js";
import { StaticSecretsResolver } from "../../src/runtime/secrets-resolver.js";
import { CONFIG_DEFAULTS, type ResolvedConfig } from "../../src/config/schema.js";
import {
  NoBillingConfigError,
  BillingEgressBlocked,
  BillingProviderError,
} from "../../src/billing/manager.js";
import {
  PlanBillingService,
  type PlanPriceStore,
  type PricingAssignment,
  type PricingExperiment,
  type PricingExperimentStore,
  type PricingExperimentVariant,
  type PlanFunnelAdvancer,
  type WorkspacePlanStore,
  type ActivePlan,
} from "../../src/billing/plan-service.js";
import { getPlan, planCaps, planPriceCents } from "../../src/billing/plans.js";

const WS = "ws-1";
const STRIPE_KEY = "sk-live-plan-secret-zzz";

/** Minimal in-memory price registry: keyed like the DB composite PK, including billing interval. */
function memPriceStore(): PlanPriceStore & { count: number } {
  const rows = new Map<string, { productId: string; priceId: string }>();
  const k = (ws: string, plan: string, prov: string, interval = "month") =>
    `${ws}|${plan}|${prov}|${interval}`;
  return {
    get count() {
      return rows.size;
    },
    find(ws, plan, prov, interval = "month") {
      return Promise.resolve(rows.get(k(ws, plan, prov, interval)));
    },
    upsert(row) {
      // ON CONFLICT DO NOTHING: first writer wins (idempotent under concurrent/repeat bootstrap).
      const key = k(row.workspaceId, row.planKey, row.provider, row.billingInterval);
      if (!rows.has(key)) rows.set(key, { productId: row.productId, priceId: row.priceId });
      return Promise.resolve();
    },
  };
}

/** Minimal in-memory workspace_plans (one active row per workspace, upserted on activation). */
function memPlanStore(): WorkspacePlanStore {
  const rows = new Map<string, ActivePlan>();
  return {
    getActive(ws) {
      return Promise.resolve(rows.get(ws));
    },
    activate({ workspaceId, planKey, caps, providerEventId, expiresAt, nextBillingAt }) {
      const row: ActivePlan = {
        workspaceId,
        planKey,
        status: "active",
        renewalStatus: "active",
        agentSeats: caps.agentSeats,
        monthlySessionBudgetCents: caps.monthlySessionBudgetCents,
        fleetSize: caps.fleetSize,
        providerEventId: providerEventId ?? null,
        expiresAt,
        nextBillingAt,
        retryCount: 0,
        retryScheduledAt: null,
        lastPaymentFailedAt: null,
        activatedAt: new Date(0),
      };
      rows.set(workspaceId, row);
      return Promise.resolve(row);
    },
    recordPaymentFailure({ workspaceId, providerEventId, retryScheduledAt, now }) {
      const row = rows.get(workspaceId);
      if (!row) return Promise.resolve(undefined);
      row.renewalStatus = "past_due";
      row.providerEventId = providerEventId;
      row.retryCount += 1;
      row.retryScheduledAt = retryScheduledAt;
      row.lastPaymentFailedAt = now;
      return Promise.resolve(row);
    },
    markExpired({ workspaceId }) {
      const row = rows.get(workspaceId);
      if (!row) return Promise.resolve(undefined);
      row.renewalStatus = "expired";
      row.status = "canceled";
      return Promise.resolve(row);
    },
    cancel({ workspaceId }) {
      const row = rows.get(workspaceId);
      if (!row) return Promise.resolve(undefined);
      row.renewalStatus = "canceled";
      row.status = "canceled";
      row.retryScheduledAt = null;
      return Promise.resolve(row);
    },
    downgrade({ workspaceId, planKey, caps }) {
      const row = rows.get(workspaceId);
      if (!row) return Promise.resolve(undefined);
      row.planKey = planKey;
      row.status = "active";
      row.renewalStatus = "active";
      row.agentSeats = caps.agentSeats;
      row.monthlySessionBudgetCents = caps.monthlySessionBudgetCents;
      row.fleetSize = caps.fleetSize;
      row.retryScheduledAt = null;
      row.lastPaymentFailedAt = null;
      return Promise.resolve(row);
    },
    dueForRetry(now) {
      return Promise.resolve(
        [...rows.values()].filter(
          (row) =>
            row.renewalStatus === "past_due" &&
            row.retryScheduledAt !== null &&
            row.retryScheduledAt <= now,
        ),
      );
    },
  };
}

function memExperimentStore(): PricingExperimentStore {
  const experiments = new Map<string, PricingExperiment>();
  const assignments = new Map<string, PricingAssignment>();
  let seq = 0;
  return {
    create(input) {
      const id = `exp-${++seq}`;
      const experiment: PricingExperiment = {
        id,
        workspaceId: input.workspaceId,
        name: input.name,
        status: "active",
        controlVariantKey: input.controlVariantKey,
        minSampleSize: input.minSampleSize,
        variants: input.variants,
        createdAt: new Date(0),
      };
      experiments.set(id, experiment);
      return Promise.resolve(experiment);
    },
    active(workspaceId) {
      return Promise.resolve(
        [...experiments.values()].find(
          (e) => e.workspaceId === workspaceId && e.status === "active",
        ),
      );
    },
    get(workspaceId, experimentId) {
      const e = experiments.get(experimentId);
      return Promise.resolve(e?.workspaceId === workspaceId ? e : undefined);
    },
    assignment(experimentId, subjectKey) {
      return Promise.resolve(
        [...assignments.values()].find(
          (a) => a.experimentId === experimentId && a.subjectKey === subjectKey,
        ),
      );
    },
    assign(input: {
      workspaceId: string;
      experimentId: string;
      subjectKey: string;
      variant: PricingExperimentVariant;
    }) {
      const existing = [...assignments.values()].find(
        (a) => a.experimentId === input.experimentId && a.subjectKey === input.subjectKey,
      );
      if (existing) return Promise.resolve(existing);
      const row: PricingAssignment = {
        id: `asg-${++seq}`,
        workspaceId: input.workspaceId,
        experimentId: input.experimentId,
        subjectKey: input.subjectKey,
        variantKey: input.variant.key,
        planKey: input.variant.planKey,
        checkoutStartedAt: null,
        convertedAt: null,
        revenueEventId: null,
        revenueCents: 0,
        createdAt: new Date(0),
      };
      assignments.set(row.id, row);
      return Promise.resolve(row);
    },
    getAssignment(workspaceId, assignmentId) {
      const row = assignments.get(assignmentId);
      return Promise.resolve(row?.workspaceId === workspaceId ? row : undefined);
    },
    markCheckout(workspaceId, assignmentId) {
      const row = assignments.get(assignmentId);
      if (row?.workspaceId === workspaceId) row.checkoutStartedAt = new Date(1);
      return Promise.resolve();
    },
    markConversion(input) {
      const row = assignments.get(input.assignmentId);
      if (row?.workspaceId === input.workspaceId && row.experimentId === input.experimentId) {
        row.convertedAt = new Date(2);
        row.revenueEventId = input.providerEventId;
        row.revenueCents = input.revenueCents;
      }
      return Promise.resolve();
    },
    assignments(workspaceId, experimentId) {
      return Promise.resolve(
        [...assignments.values()].filter(
          (a) => a.workspaceId === workspaceId && a.experimentId === experimentId,
        ),
      );
    },
  };
}

function makeService(opts: { config?: Partial<ResolvedConfig> | null; funnel?: PlanFunnelAdvancer } = {}) {
  const provider = new NoneBillingProvider();
  const prices = memPriceStore();
  const plans = memPlanStore();
  const loadConfig = (): ResolvedConfig => ({
    ...CONFIG_DEFAULTS,
    billing: opts.config === null ? undefined : { provider: "none", currency: "usd" },
    ...(opts.config && opts.config !== null ? opts.config : {}),
  });
  const service = new PlanBillingService({
    provider,
    prices,
    plans,
    pricingExperiments: memExperimentStore(),
    secrets: new StaticSecretsResolver({ STRIPE_SECRET_KEY: STRIPE_KEY }),
    loadConfig,
    ...(opts.funnel ? { funnel: opts.funnel } : {}),
  });
  return { service, provider, prices, plans };
}

describe("PlanBillingService (#125 — no-network none provider)", () => {
  it("lists the catalog with no active plan for a fresh workspace", async () => {
    const { service } = makeService();
    const res = await service.listPlans(WS);
    expect(res.plans.map((p) => p.key)).toEqual(["starter", "pro", "agency"]);
    expect(res.current).toBeNull();
  });

  it("mints a checkout link carrying plan-checkout metadata", async () => {
    const { service, provider } = makeService();
    const out = await service.createCheckout({
      workspaceId: WS,
      planKey: "pro",
      billingEmail: " Buyer@Example.COM ",
      trackingRef: "ipop_deadbeefdeadbeef",
    });
    expect(out.url).toMatch(/^https:\/\/.+/);
    expect(out.planKey).toBe("pro");
    expect(out.billingInterval).toBe("month");
    const link = provider.links.at(-1)!;
    expect(link.metadata).toMatchObject({
      workspaceId: WS,
      planKey: "pro",
      billingInterval: "month",
      kind: "plan_checkout",
      customerEmail: "buyer@example.com",
      trackingRef: "ipop_deadbeefdeadbeef",
    });
    expect(link.customerEmail).toBe("buyer@example.com");
    expect(link.collectTax).toBe(true);
    expect(link.collectTaxIds).toBe(true);
    expect(link.billingAddressCollection).toBe("required");
    expect(provider.products.at(-1)).toMatchObject({
      taxCode: "txcd_10103001",
      taxBehavior: "exclusive",
    });
  });

  it("ensures the price once — a second checkout reuses the registry (no duplicate product)", async () => {
    const { service, provider, prices } = makeService();
    await service.createCheckout({ workspaceId: WS, planKey: "pro" });
    await service.createCheckout({ workspaceId: WS, planKey: "pro" });
    expect(provider.products).toHaveLength(1); // createProductPrice called exactly once
    expect(prices.count).toBe(1);
  });

  it("creates a distinct annual checkout price and metadata for self-serve yearly plans (#606)", async () => {
    const { service, provider, prices } = makeService();
    const out = await service.createCheckout({ workspaceId: WS, planKey: "pro", billingInterval: "year" });

    expect(out).toMatchObject({ planKey: "pro", billingInterval: "year" });
    expect(out.url).toContain("plan-pro-year");
    expect(provider.products).toHaveLength(1);
    expect(provider.products[0]).toMatchObject({
      name: "ipop Pro annual",
      amountCents: planPriceCents(getPlan("pro")!, "year"),
      interval: "year",
    });
    expect(provider.links[0]?.metadata).toMatchObject({ planKey: "pro", billingInterval: "year" });
    expect(prices.count).toBe(1);

    await service.createCheckout({ workspaceId: WS, planKey: "pro", billingInterval: "month" });
    expect(provider.products).toHaveLength(2);
    expect(prices.count).toBe(2);
  });

  it("bootstrap creates every plan's price once and is idempotent on a second run", async () => {
    const { service, provider, prices } = makeService();
    const first = await service.bootstrap(WS);
    expect(first.created.sort()).toEqual(["agency", "pro", "starter"]);
    expect(prices.count).toBe(3);
    expect(provider.products).toHaveLength(3);

    const second = await service.bootstrap(WS);
    expect(second.created).toEqual([]); // nothing new
    expect(second.existing.sort()).toEqual(["agency", "pro", "starter"]);
    expect(provider.products).toHaveLength(3); // no extra network calls
  });

  it("activates a plan and updates the workspace caps to match the catalog", async () => {
    const { service } = makeService();
    const active = await service.activate(WS, "pro", "evt_1");
    const pro = getPlan("pro")!;
    expect(active.planKey).toBe("pro");
    expect({
      agentSeats: active.agentSeats,
      monthlySessionBudgetCents: active.monthlySessionBudgetCents,
      fleetSize: active.fleetSize,
    }).toEqual(planCaps(pro));

    // Re-activating to a different plan replaces the caps (upsert by workspace).
    const upgraded = await service.activate(WS, "agency", "evt_2");
    expect(upgraded.planKey).toBe("agency");
    const current = (await service.listPlans(WS)).current;
    expect(current?.planKey).toBe("agency");
    expect(current?.fleetSize).toBe(planCaps(getPlan("agency")!).fleetSize);
  });

  it("advances a tracked paid checkout into the post-sales GTM stage", async () => {
    const postSales: Array<{ workspaceId: string; prospectKey: string; externalRef: string; planKey: string; amountCents: number }> = [];
    const { service } = makeService({
      funnel: {
        advancePostSales: async (input) => {
          postSales.push(input);
        },
      },
    });

    await service.activate(WS, "pro", "evt_paid_1", { trackingRef: "ipop_paidprospect1" }, 4900);
    await service.activate(WS, "agency", "evt_paid_2", { trackingRef: "not-ours" }, 9900);

    expect(postSales).toEqual([
      {
        workspaceId: WS,
        prospectKey: "ipop_paidprospect1",
        externalRef: "evt_paid_1",
        planKey: "pro",
        amountCents: 4900,
      },
    ]);
  });

  it("sets a renewal window on activation and moves failed renewals into dunning", async () => {
    const { service } = makeService();
    const active = await service.activate(WS, "pro", "evt_paid");
    expect(active.renewalStatus).toBe("active");
    expect(active.expiresAt.getTime()).toBeGreaterThan(Date.now());
    expect(active.nextBillingAt.getTime()).toBe(active.expiresAt.getTime());

    const failed = await service.recordPaymentFailure(WS, "evt_failed");
    expect(failed).toMatchObject({
      renewalStatus: "past_due",
      retryCount: 1,
      providerEventId: "evt_failed",
    });
    expect(failed?.retryScheduledAt).toBeInstanceOf(Date);
  });

  it("expires active plans when the billing window has passed", async () => {
    const { service, plans } = makeService();
    await plans.activate({
      workspaceId: WS,
      planKey: "starter",
      caps: planCaps(getPlan("starter")!),
      providerEventId: "evt_old",
      expiresAt: new Date(0),
      nextBillingAt: new Date(0),
    });
    const listing = await service.listPlans(WS);
    expect(listing.current?.renewalStatus).toBe("expired");
    expect(listing.current?.status).toBe("canceled");
  });

  it("supports self-serve cancel and downgrade over the active workspace plan (#914)", async () => {
    const { service } = makeService();
    await service.activate(WS, "agency", "evt_paid");

    const downgraded = await service.downgrade(WS, "starter");
    expect(downgraded).toMatchObject({
      planKey: "starter",
      status: "active",
      renewalStatus: "active",
      fleetSize: planCaps(getPlan("starter")!).fleetSize,
    });

    const canceled = await service.cancel(WS);
    expect(canceled).toMatchObject({
      planKey: "starter",
      status: "canceled",
      renewalStatus: "canceled",
    });
  });

  it("rejects checkout for an unknown plan key", async () => {
    const { service } = makeService();
    await expect(
      service.createCheckout({ workspaceId: WS, planKey: "enterprise" }),
    ).rejects.toThrow();
  });

  it("gates checkout: 409-equivalent when billing is not enabled (opt-in)", async () => {
    const { service } = makeService({ config: null });
    await expect(
      service.createCheckout({ workspaceId: WS, planKey: "pro" }),
    ).rejects.toBeInstanceOf(NoBillingConfigError);
  });

  it("gates checkout: blocked under data-privacy mode (egress off)", async () => {
    const { service } = makeService({ config: { dataPrivacyMode: true } });
    await expect(
      service.createCheckout({ workspaceId: WS, planKey: "pro" }),
    ).rejects.toBeInstanceOf(BillingEgressBlocked);
  });

  it("redacts a provider failure (a leaked secret never reaches the thrown error)", async () => {
    const { service, provider } = makeService();
    provider.failNext = `boom key=${STRIPE_KEY}`;
    await service
      .createCheckout({ workspaceId: WS, planKey: "starter" })
      .then(() => expect.fail("should have thrown"))
      .catch((err: unknown) => {
        expect(err).toBeInstanceOf(BillingProviderError);
        expect((err as Error).message).not.toContain(STRIPE_KEY);
        expect((err as Error).message).toContain("‹redacted›");
      });
  });

  it("runs a sticky pricing cohort, honors the assigned plan at checkout, and reports revenue lift", async () => {
    const { service, provider } = makeService();
    const experiment = await service.createPricingExperiment({
      workspaceId: WS,
      name: "Starter vs Pro packaging",
      controlVariantKey: "starter",
      minSampleSize: 1,
      variants: [
        { key: "starter", planKey: "starter", label: "Starter card", weightBps: 5000 },
        { key: "pro", planKey: "pro", label: "Pro card", weightBps: 5000 },
      ],
    });

    const first = await service.listPlans(WS, { subjectKey: "visitor-pro" });
    const again = await service.listPlans(WS, { subjectKey: "visitor-pro" });
    expect(first.pricingExperiment?.assignmentId).toBe(again.pricingExperiment?.assignmentId);
    expect(first.pricingExperiment?.variantKey).toBe(again.pricingExperiment?.variantKey);

    const assignedPlan = first.pricingExperiment!.planKey;
    const otherPlan = assignedPlan === "pro" ? "starter" : "pro";
    await expect(
      service.createCheckout({
        workspaceId: WS,
        planKey: otherPlan,
        pricingAssignmentId: first.pricingExperiment!.assignmentId,
      }),
    ).rejects.toThrow(/assigned pricing experiment/i);

    await service.createCheckout({
      workspaceId: WS,
      planKey: assignedPlan,
      pricingAssignmentId: first.pricingExperiment!.assignmentId,
    });
    const link = provider.links.at(-1)!;
    expect(link.metadata).toMatchObject({
      pricingExperimentId: experiment.id,
      pricingAssignmentId: first.pricingExperiment!.assignmentId,
      pricingVariantKey: first.pricingExperiment!.variantKey,
    });

    await service.activate(
      WS,
      assignedPlan,
      "evt_pricing_1",
      link.metadata,
      getPlan(assignedPlan)!.priceCents,
    );
    const report = await service.pricingExperimentReport(WS, experiment.id);
    const winner = report.variants.find(
      (v) => v.variantKey === first.pricingExperiment!.variantKey,
    )!;
    expect(winner.assignments).toBe(1);
    expect(winner.checkouts).toBe(1);
    expect(winner.conversions).toBe(1);
    expect(winner.revenueCents).toBe(getPlan(assignedPlan)!.priceCents);
    expect(winner.significance).toBe("directional");
  });
});
