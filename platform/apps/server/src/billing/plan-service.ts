import type { ResolvedConfig } from "../config/schema.js";
import { loadConfig } from "../config/loader.js";
import { egressAllowed } from "../config/egress.js";
import type { SecretsResolver } from "../runtime/secrets-resolver.js";
import { makeRedactor } from "../runtime/redact.js";
import type { SessionLogger } from "../runtime/manager.js";
import type { BillingProvider } from "./provider.js";
import {
  BillingEgressBlocked,
  BillingProviderError,
  NoBillingConfigError,
  type PlanActivator,
} from "./manager.js";
import { getPlan, planCaps, PLANS, type Plan, type PlanCaps, type PlanKey } from "./plans.js";

/**
 * PlanBillingService (#125, ADR-0125) — the thin pricing/plan layer over the merged #98 rails. It does
 * exactly the three things #98 left open: catalog the plans, mint a **workspace-scoped** checkout
 * (#98's checkout is session-scoped), and activate a plan when the merged webhook reports a payment.
 *
 * It reuses every #98 primitive: the swappable {@link BillingProvider} seam (inbound-only — no way to
 * move money out), the per-tenant {@link SecretsResolver}, the redactor, and the opt-in + egress gate.
 * The default `NoneBillingProvider` keeps dev/CI at zero network. It implements {@link PlanActivator} so
 * the BillingManager can call `activate` from the webhook path without a circular import.
 */

/** One active plan row (the `workspace_plans` projection). */
export interface ActivePlan {
  workspaceId: string;
  planKey: PlanKey;
  status: string;
  agentSeats: number;
  monthlySessionBudgetCents: number;
  fleetSize: number;
  providerEventId: string | null;
  activatedAt: Date;
}

/** A persisted product/price for a plan (the idempotent registry row). */
export interface PlanPriceRow {
  workspaceId: string;
  planKey: PlanKey;
  provider: string;
  productId: string;
  priceId: string;
}

/** The idempotent price registry seam (DB repo in prod; in-memory in unit tests). */
export interface PlanPriceStore {
  find(
    workspaceId: string,
    planKey: PlanKey,
    provider: string,
  ): Promise<{ productId: string; priceId: string } | undefined>;
  /** Insert-if-absent (ON CONFLICT DO NOTHING) so a repeat bootstrap creates no duplicate product. */
  upsert(row: PlanPriceRow): Promise<void>;
}

/** The active-plan persistence seam (one upserted row per workspace). */
export interface WorkspacePlanStore {
  getActive(workspaceId: string): Promise<ActivePlan | undefined>;
  activate(input: {
    workspaceId: string;
    planKey: PlanKey;
    caps: PlanCaps;
    providerEventId: string | null;
  }): Promise<ActivePlan>;
}

export interface PlanCheckoutRequest {
  workspaceId: string;
  planKey: string;
  createdByMemberId?: string;
}

export interface PlanCheckoutResult {
  url: string;
  planKey: PlanKey;
  priceId: string;
}

export interface PlanListing {
  plans: readonly Plan[];
  current: ActivePlan | null;
}

export interface BootstrapResult {
  provider: string;
  /** Plans whose price was created on this run. */
  created: PlanKey[];
  /** Plans whose price already existed (no-op). */
  existing: PlanKey[];
}

/** Thrown when a checkout/activation references a plan key not in the catalog → route 400. */
export class UnknownPlanError extends Error {
  constructor(key: string) {
    super(`unknown plan: ${key}`);
    this.name = "UnknownPlanError";
  }
}

export interface PlanBillingServiceDeps {
  provider: BillingProvider;
  prices: PlanPriceStore;
  plans: WorkspacePlanStore;
  secrets: SecretsResolver;
  loadConfig?: (workspaceId: string) => ResolvedConfig;
  logger?: SessionLogger;
}

export class PlanBillingService implements PlanActivator {
  private readonly provider: BillingProvider;
  private readonly prices: PlanPriceStore;
  private readonly store: WorkspacePlanStore;
  private readonly secrets: SecretsResolver;
  private readonly load: (workspaceId: string) => ResolvedConfig;
  private readonly logger?: SessionLogger;

  constructor(deps: PlanBillingServiceDeps) {
    this.provider = deps.provider;
    this.prices = deps.prices;
    this.store = deps.plans;
    this.secrets = deps.secrets;
    this.load = deps.loadConfig ?? ((workspaceId) => loadConfig(workspaceId));
    this.logger = deps.logger;
  }

  /** The `/pricing` payload: the static catalog + the workspace's currently active plan (or null). */
  async listPlans(workspaceId: string): Promise<PlanListing> {
    const current = await this.store.getActive(workspaceId);
    return { plans: PLANS, current: current ?? null };
  }

  /**
   * Mint a hosted checkout link for a plan (INBOUND money). Enforces the same opt-in + egress gate as
   * the #98 payment-link route (→ 409), ensures the plan's price exists (find-or-create — idempotent),
   * and calls the provider seam with `kind: "plan_checkout"` metadata so the webhook can activate the
   * plan. A provider failure is wrapped in a **redacted** {@link BillingProviderError} (→ 502).
   */
  async createCheckout(req: PlanCheckoutRequest): Promise<PlanCheckoutResult> {
    const plan = getPlan(req.planKey);
    if (!plan) throw new UnknownPlanError(req.planKey);
    this.gate(req.workspaceId);
    const secrets = await this.secrets.resolve(req.workspaceId);
    const redact = makeRedactor(secrets);
    try {
      const { priceId } = await this.ensurePrice(req.workspaceId, plan, secrets);
      const link = await this.provider.createPaymentLink({
        priceId,
        slug: this.slug(req.workspaceId, plan.key),
        metadata: {
          workspaceId: req.workspaceId,
          planKey: plan.key,
          // Round-tripped on the webhook so the merged ingest path knows to activate the plan.
          kind: "plan_checkout",
        },
        secrets,
      });
      return { url: link.url, planKey: plan.key, priceId };
    } catch (err) {
      if (err instanceof UnknownPlanError) throw err;
      throw new BillingProviderError(redact(err instanceof Error ? err.message : String(err)));
    }
  }

  /**
   * Activate a plan for a workspace: upsert `workspace_plans` from the catalog caps. Called once per
   * payment from the deduped webhook path (a replay never reaches here). Unknown plan keys are a no-op
   * (logged) so a malformed-but-signed webhook can never throw after verification.
   */
  async activate(
    workspaceId: string,
    planKey: string,
    providerEventId: string,
  ): Promise<ActivePlan | undefined> {
    const plan = getPlan(planKey);
    if (!plan) {
      this.logger?.warn({ workspaceId, planKey }, "billing: ignoring activation for unknown plan");
      return undefined;
    }
    return this.store.activate({
      workspaceId,
      planKey: plan.key,
      caps: planCaps(plan),
      providerEventId,
    });
  }

  /**
   * Idempotently create the Stripe products/prices for every plan (the `billing:bootstrap` operation).
   * With the no-network `none` provider this mints synthetic ids and never spends; with `stripe` it
   * creates each product/price exactly once (a second run is a pure no-op via the registry). Never logs
   * a secret value.
   */
  async bootstrap(workspaceId: string): Promise<BootstrapResult> {
    const secrets = await this.secrets.resolve(workspaceId);
    const redact = makeRedactor(secrets);
    const created: PlanKey[] = [];
    const existing: PlanKey[] = [];
    for (const plan of PLANS) {
      const had = await this.prices.find(workspaceId, plan.key, this.provider.kind);
      try {
        await this.ensurePrice(workspaceId, plan, secrets);
      } catch (err) {
        // Redact any leaked secret out of a provider failure before it surfaces to the CLI/logs.
        throw new BillingProviderError(redact(err instanceof Error ? err.message : String(err)));
      }
      (had ? existing : created).push(plan.key);
    }
    return { provider: this.provider.kind, created, existing };
  }

  // --- internals ---

  /** Find the plan's persisted price or create + persist it (idempotent under the registry's PK). */
  private async ensurePrice(
    workspaceId: string,
    plan: Plan,
    secrets: Record<string, string>,
  ): Promise<{ productId: string; priceId: string }> {
    const existing = await this.prices.find(workspaceId, plan.key, this.provider.kind);
    if (existing) return existing;
    const pp = await this.provider.createProductPrice({
      name: `ipop ${plan.name}`,
      amountCents: plan.priceCents,
      currency: plan.currency,
      interval: plan.interval,
      secrets,
    });
    await this.prices.upsert({
      workspaceId,
      planKey: plan.key,
      provider: this.provider.kind,
      productId: pp.productId,
      priceId: pp.priceId,
    });
    // Re-read so a concurrent bootstrap that won the ON CONFLICT race returns the persisted row.
    const stored = await this.prices.find(workspaceId, plan.key, this.provider.kind);
    return stored ?? { productId: pp.productId, priceId: pp.priceId };
  }

  /** Enforce the opt-in (`billing` config) + egress (data-privacy) invariants for an outbound call. */
  private gate(workspaceId: string): ResolvedConfig {
    const cfg = this.load(workspaceId);
    if (!cfg.billing) throw new NoBillingConfigError();
    if (!egressAllowed(cfg)) throw new BillingEgressBlocked();
    return cfg;
  }

  private slug(workspaceId: string, planKey: PlanKey): string {
    return `plan-${planKey}-${workspaceId}`.replace(/[^a-zA-Z0-9-]/g, "-").toLowerCase();
  }
}
