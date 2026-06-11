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
  type WorkspacePlanStore,
  type ActivePlan,
} from "../../src/billing/plan-service.js";
import { getPlan, planCaps } from "../../src/billing/plans.js";

const WS = "ws-1";
const STRIPE_KEY = "sk-live-plan-secret-zzz";

/** Minimal in-memory price registry: keyed by `${ws}|${plan}|${provider}` (the DB composite PK). */
function memPriceStore(): PlanPriceStore & { count: number } {
  const rows = new Map<string, { productId: string; priceId: string }>();
  const k = (ws: string, plan: string, prov: string) => `${ws}|${plan}|${prov}`;
  return {
    get count() {
      return rows.size;
    },
    find(ws, plan, prov) {
      return Promise.resolve(rows.get(k(ws, plan, prov)));
    },
    upsert(row) {
      // ON CONFLICT DO NOTHING: first writer wins (idempotent under concurrent/repeat bootstrap).
      const key = k(row.workspaceId, row.planKey, row.provider);
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
    activate({ workspaceId, planKey, caps, providerEventId }) {
      const row: ActivePlan = {
        workspaceId,
        planKey,
        status: "active",
        agentSeats: caps.agentSeats,
        monthlySessionBudgetCents: caps.monthlySessionBudgetCents,
        fleetSize: caps.fleetSize,
        providerEventId: providerEventId ?? null,
        activatedAt: new Date(0),
      };
      rows.set(workspaceId, row);
      return Promise.resolve(row);
    },
  };
}

function makeService(opts: { config?: Partial<ResolvedConfig> | null } = {}) {
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
    secrets: new StaticSecretsResolver({ STRIPE_SECRET_KEY: STRIPE_KEY }),
    loadConfig,
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
    const out = await service.createCheckout({ workspaceId: WS, planKey: "pro" });
    expect(out.url).toMatch(/^https:\/\/.+/);
    expect(out.planKey).toBe("pro");
    const link = provider.links.at(-1)!;
    expect(link.metadata).toMatchObject({ workspaceId: WS, planKey: "pro", kind: "plan_checkout" });
  });

  it("ensures the price once — a second checkout reuses the registry (no duplicate product)", async () => {
    const { service, provider, prices } = makeService();
    await service.createCheckout({ workspaceId: WS, planKey: "pro" });
    await service.createCheckout({ workspaceId: WS, planKey: "pro" });
    expect(provider.products).toHaveLength(1); // createProductPrice called exactly once
    expect(prices.count).toBe(1);
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

  it("rejects checkout for an unknown plan key", async () => {
    const { service } = makeService();
    await expect(service.createCheckout({ workspaceId: WS, planKey: "enterprise" })).rejects.toThrow();
  });

  it("gates checkout: 409-equivalent when billing is not enabled (opt-in)", async () => {
    const { service } = makeService({ config: null });
    await expect(service.createCheckout({ workspaceId: WS, planKey: "pro" })).rejects.toBeInstanceOf(
      NoBillingConfigError,
    );
  });

  it("gates checkout: blocked under data-privacy mode (egress off)", async () => {
    const { service } = makeService({ config: { dataPrivacyMode: true } });
    await expect(service.createCheckout({ workspaceId: WS, planKey: "pro" })).rejects.toBeInstanceOf(
      BillingEgressBlocked,
    );
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
});
