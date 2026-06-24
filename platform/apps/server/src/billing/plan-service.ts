import type { ResolvedConfig } from "../config/schema.js";
import { loadConfig } from "../config/loader.js";
import { egressAllowed } from "../config/egress.js";
import type { SecretsResolver } from "../runtime/secrets-resolver.js";
import { makeRedactor } from "../runtime/redact.js";
import type { SessionLogger } from "../runtime/manager.js";
import type { BillingProvider } from "./provider.js";
import type { TrialNurtureService } from "./trial-nurture.js";
import {
  BillingEgressBlocked,
  BillingProviderError,
  NoBillingConfigError,
  type PlanActivator,
} from "./manager.js";
import { getPlan, planCaps, PLANS, type Plan, type PlanCaps, type PlanKey } from "./plans.js";
import { sanitizeTrackingRef } from "../attribution/tracking.js";

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

export type PricingExperimentStatus = "active" | "paused" | "completed";
export type PricingSignificance = "insufficient_sample" | "directional" | "significant";

export interface PricingExperimentVariant {
  key: string;
  planKey: PlanKey;
  label: string;
  weightBps: number;
}

export interface PricingExperiment {
  id: string;
  workspaceId: string;
  name: string;
  status: PricingExperimentStatus;
  controlVariantKey: string;
  minSampleSize: number;
  variants: PricingExperimentVariant[];
  createdAt: Date;
}

export interface PricingAssignment {
  id: string;
  workspaceId: string;
  experimentId: string;
  subjectKey: string;
  variantKey: string;
  planKey: PlanKey;
  checkoutStartedAt: Date | null;
  convertedAt: Date | null;
  revenueEventId: string | null;
  revenueCents: number;
  createdAt: Date;
}

export interface PricingExperimentSelection {
  experimentId: string;
  assignmentId: string;
  variantKey: string;
  planKey: PlanKey;
}

export interface PricingVariantReport {
  variantKey: string;
  planKey: PlanKey;
  assignments: number;
  checkouts: number;
  conversions: number;
  revenueCents: number;
  conversionRate: number;
  revenuePerVisitorCents: number;
  liftVsControlBps: number | null;
  significance: PricingSignificance;
}

export interface PricingExperimentReport {
  experimentId: string;
  workspaceId: string;
  name: string;
  status: PricingExperimentStatus;
  controlVariantKey: string;
  minSampleSize: number;
  variants: PricingVariantReport[];
}

export interface CreatePricingExperimentInput {
  workspaceId: string;
  name: string;
  controlVariantKey?: string;
  minSampleSize?: number;
  variants: Array<{
    key: string;
    planKey: string;
    label?: string;
    weightBps?: number;
  }>;
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

export interface PricingExperimentStore {
  create(input: {
    workspaceId: string;
    name: string;
    controlVariantKey: string;
    minSampleSize: number;
    variants: PricingExperimentVariant[];
  }): Promise<PricingExperiment>;
  active(workspaceId: string): Promise<PricingExperiment | undefined>;
  get(workspaceId: string, experimentId: string): Promise<PricingExperiment | undefined>;
  assignment(experimentId: string, subjectKey: string): Promise<PricingAssignment | undefined>;
  assign(input: {
    workspaceId: string;
    experimentId: string;
    subjectKey: string;
    variant: PricingExperimentVariant;
  }): Promise<PricingAssignment>;
  getAssignment(workspaceId: string, assignmentId: string): Promise<PricingAssignment | undefined>;
  markCheckout(workspaceId: string, assignmentId: string): Promise<void>;
  markConversion(input: {
    workspaceId: string;
    experimentId: string;
    assignmentId: string;
    providerEventId: string;
    revenueCents: number;
  }): Promise<void>;
  assignments(workspaceId: string, experimentId: string): Promise<PricingAssignment[]>;
}

export interface PlanCheckoutRequest {
  workspaceId: string;
  planKey: string;
  createdByMemberId?: string;
  /** In-app URL to return the customer to after a successful payment (validated http/https by the route). */
  returnUrl?: string;
  /**
   * Optional #386 tracking ref (slice 3) to stamp into Stripe checkout metadata so the resulting payment
   * attributes to the artifact/lead that drove it. Sanitized before it reaches Stripe (#200 §6). The route
   * does not yet recover a ref off the landing URL (gap 4) — the FIELD is plumbed so a supplied ref is
   * stored; the landing-recovery source is the follow-up.
   */
  trackingRef?: string | null;
  /** Sticky A/B pricing assignment id from listPlans; checkout rejects mismatches to honor shown price. */
  pricingAssignmentId?: string | null;
}

export interface PlanCheckoutResult {
  url: string;
  planKey: PlanKey;
  priceId: string;
}

export interface PlanListing {
  plans: readonly Plan[];
  current: ActivePlan | null;
  pricingExperiment?: PricingExperimentSelection | null;
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
  pricingExperiments?: PricingExperimentStore;
  trialNurture?: TrialNurtureService;
  secrets: SecretsResolver;
  loadConfig?: (workspaceId: string) => ResolvedConfig;
  logger?: SessionLogger;
}

export class PlanBillingService implements PlanActivator {
  private readonly provider: BillingProvider;
  private readonly prices: PlanPriceStore;
  private readonly store: WorkspacePlanStore;
  private readonly pricingExperiments?: PricingExperimentStore;
  private readonly trialNurture?: TrialNurtureService;
  private readonly secrets: SecretsResolver;
  private readonly load: (workspaceId: string) => ResolvedConfig;
  private readonly logger?: SessionLogger;

  constructor(deps: PlanBillingServiceDeps) {
    this.provider = deps.provider;
    this.prices = deps.prices;
    this.store = deps.plans;
    this.pricingExperiments = deps.pricingExperiments;
    this.trialNurture = deps.trialNurture;
    this.secrets = deps.secrets;
    this.load = deps.loadConfig ?? ((workspaceId) => loadConfig(workspaceId));
    this.logger = deps.logger;
  }

  /** The `/pricing` payload: the static catalog + the workspace's currently active plan (or null). */
  async listPlans(workspaceId: string, opts: { subjectKey?: string | null } = {}): Promise<PlanListing> {
    const current = await this.store.getActive(workspaceId);
    const pricingExperiment = await this.assignPricingExperiment(workspaceId, opts.subjectKey ?? null);
    return { plans: PLANS, current: current ?? null, pricingExperiment };
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
    const pricingAssignment = await this.validatePricingAssignment(req.workspaceId, plan.key, req.pricingAssignmentId);
    this.gate(req.workspaceId);
    const secrets = await this.secrets.resolve(req.workspaceId);
    const redact = makeRedactor(secrets);
    // #386 slice 3: stamp a (sanitized) tracking ref into checkout metadata so the resulting payment can be
    // attributed to the artifact/lead that drove it. Garbage/absent ⇒ omitted ⇒ unattributed (honest).
    const trackingRef = sanitizeTrackingRef(req.trackingRef);
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
          ...(pricingAssignment
            ? {
                pricingExperimentId: pricingAssignment.experimentId,
                pricingAssignmentId: pricingAssignment.id,
                pricingVariantKey: pricingAssignment.variantKey,
              }
            : {}),
          ...(trackingRef ? { trackingRef } : {}),
        },
        ...(req.returnUrl ? { returnUrl: req.returnUrl } : {}),
        secrets,
      });
      if (pricingAssignment) await this.pricingExperiments?.markCheckout(req.workspaceId, pricingAssignment.id);
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
    metadata: Record<string, string> = {},
    amountCents = 0,
  ): Promise<ActivePlan | undefined> {
    const plan = getPlan(planKey);
    if (!plan) {
      this.logger?.warn({ workspaceId, planKey }, "billing: ignoring activation for unknown plan");
      return undefined;
    }
    const active = await this.store.activate({
      workspaceId,
      planKey: plan.key,
      caps: planCaps(plan),
      providerEventId,
    });
    if (metadata.pricingExperimentId && metadata.pricingAssignmentId && this.pricingExperiments) {
      await this.pricingExperiments.markConversion({
        workspaceId,
        experimentId: metadata.pricingExperimentId,
        assignmentId: metadata.pricingAssignmentId,
        providerEventId,
        revenueCents: amountCents,
      });
    }
    await this.trialNurture?.markPaid(workspaceId, providerEventId, amountCents);
    return active;
  }

  async createPricingExperiment(input: CreatePricingExperimentInput): Promise<PricingExperiment> {
    if (!this.pricingExperiments) throw new Error("pricing experiments unavailable");
    const variants = normalizeVariants(input.variants);
    const controlVariantKey = input.controlVariantKey ?? variants[0]!.key;
    if (!variants.some((v) => v.key === controlVariantKey)) {
      throw new Error("control variant must exist");
    }
    return this.pricingExperiments.create({
      workspaceId: input.workspaceId,
      name: input.name.trim() || "Pricing experiment",
      controlVariantKey,
      minSampleSize: Math.max(1, Math.trunc(input.minSampleSize ?? 30)),
      variants,
    });
  }

  async pricingExperimentReport(workspaceId: string, experimentId: string): Promise<PricingExperimentReport> {
    if (!this.pricingExperiments) throw new Error("pricing experiments unavailable");
    const experiment = await this.pricingExperiments.get(workspaceId, experimentId);
    if (!experiment) throw new Error("pricing experiment not found");
    const rows = await this.pricingExperiments.assignments(workspaceId, experimentId);
    return buildPricingReport(experiment, rows);
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

  private async assignPricingExperiment(
    workspaceId: string,
    subjectKey: string | null,
  ): Promise<PricingExperimentSelection | null> {
    if (!this.pricingExperiments || !subjectKey) return null;
    const experiment = await this.pricingExperiments.active(workspaceId);
    if (!experiment) return null;
    const existing = await this.pricingExperiments.assignment(experiment.id, subjectKey);
    const assignment =
      existing ??
      (await this.pricingExperiments.assign({
        workspaceId,
        experimentId: experiment.id,
        subjectKey,
        variant: chooseVariant(experiment.variants, subjectKey),
      }));
    return {
      experimentId: assignment.experimentId,
      assignmentId: assignment.id,
      variantKey: assignment.variantKey,
      planKey: assignment.planKey,
    };
  }

  private async validatePricingAssignment(
    workspaceId: string,
    planKey: PlanKey,
    assignmentId?: string | null,
  ): Promise<PricingAssignment | null> {
    if (!assignmentId) return null;
    const assignment = await this.pricingExperiments?.getAssignment(workspaceId, assignmentId);
    if (!assignment) throw new Error("assigned pricing experiment not found");
    if (assignment.planKey !== planKey) {
      throw new Error("assigned pricing experiment plan mismatch");
    }
    return assignment;
  }
}

function normalizeVariants(input: CreatePricingExperimentInput["variants"]): PricingExperimentVariant[] {
  if (input.length < 2) throw new Error("pricing experiment requires at least two variants");
  const variants = input.map((v) => {
    const plan = getPlan(v.planKey);
    if (!plan) throw new UnknownPlanError(v.planKey);
    return {
      key: cleanKey(v.key),
      planKey: plan.key,
      label: (v.label ?? plan.name).slice(0, 120),
      weightBps: Math.max(1, Math.trunc(v.weightBps ?? Math.floor(10_000 / input.length))),
    };
  });
  const seen = new Set<string>();
  for (const variant of variants) {
    if (seen.has(variant.key)) throw new Error("variant keys must be unique");
    seen.add(variant.key);
  }
  return variants;
}

function cleanKey(key: string): string {
  const clean = key.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
  if (!clean) throw new Error("variant key required");
  return clean.slice(0, 80);
}

function chooseVariant(variants: PricingExperimentVariant[], subjectKey: string): PricingExperimentVariant {
  const total = variants.reduce((sum, v) => sum + v.weightBps, 0);
  const bucket = stableBucket(subjectKey, total);
  let cursor = 0;
  for (const variant of variants) {
    cursor += variant.weightBps;
    if (bucket < cursor) return variant;
  }
  return variants[variants.length - 1]!;
}

function stableBucket(value: string, modulo: number): number {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return Math.abs(hash) % Math.max(1, modulo);
}

function buildPricingReport(
  experiment: PricingExperiment,
  assignments: PricingAssignment[],
): PricingExperimentReport {
  const controlRows = assignments.filter((a) => a.variantKey === experiment.controlVariantKey);
  const controlRate = rate(controlRows.filter((a) => a.convertedAt).length, controlRows.length);
  const variants = experiment.variants.map((variant) => {
    const rows = assignments.filter((a) => a.variantKey === variant.key);
    const conversions = rows.filter((a) => a.convertedAt).length;
    const conversionRate = rate(conversions, rows.length);
    const revenueCents = rows.reduce((sum, a) => sum + a.revenueCents, 0);
    return {
      variantKey: variant.key,
      planKey: variant.planKey,
      assignments: rows.length,
      checkouts: rows.filter((a) => a.checkoutStartedAt).length,
      conversions,
      revenueCents,
      conversionRate,
      revenuePerVisitorCents: rows.length ? Math.round(revenueCents / rows.length) : 0,
      liftVsControlBps: variant.key === experiment.controlVariantKey ? null : Math.round((conversionRate - controlRate) * 10_000),
      significance: significance(rows.length, controlRows.length, conversionRate, controlRate, experiment.minSampleSize),
    };
  });
  return {
    experimentId: experiment.id,
    workspaceId: experiment.workspaceId,
    name: experiment.name,
    status: experiment.status,
    controlVariantKey: experiment.controlVariantKey,
    minSampleSize: experiment.minSampleSize,
    variants,
  };
}

function rate(num: number, denom: number): number {
  return denom > 0 ? num / denom : 0;
}

function significance(
  sample: number,
  controlSample: number,
  rateValue: number,
  controlRate: number,
  minSampleSize: number,
): PricingSignificance {
  if (sample < minSampleSize) return "insufficient_sample";
  if (controlSample < minSampleSize) return "directional";
  return Math.abs(rateValue - controlRate) >= 0.1 ? "significant" : "directional";
}
