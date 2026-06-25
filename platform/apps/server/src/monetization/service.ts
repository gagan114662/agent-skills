/**
 * Venture monetization IO orchestrator (#188, ADR-0188). Mirrors the #194 finance + #187 factory services:
 * one injected seam per collaborator (the plan/experiment/revenue store, the per-venture Stripe vault, the
 * #13 money-decision gate, the inbound-only #98 billing provider), and the pure decision math lives in
 * `pricing.ts`. So the service runs against fakes in unit tests and the real repos/providers in `default.ts`.
 *
 * The premortem (#200) is enforced at every seam:
 *   - **FM#4 money is irreversible**: drafting is free; ACTIVATING (so customers can be charged),
 *     re-pricing, and payout changes ALWAYS queue as #13 MONEY decisions with the exact amount shown. A
 *     live payment link is minted ONLY after the owner's go (and only collects — inbound — never pays out).
 *   - **FM#2 external receipts only**: per-venture revenue is recorded ONLY from signature-verified webhook
 *     deliveries; experiment outcomes are computed from those receipts, never from the projection.
 *   - The venture's Stripe key comes from the #192 write-only vault keyed `stripe:<ventureIdeaId>` — never
 *     ipop's key, never logged.
 */

import type { ApprovalStatus } from "../approvals/policy.js";
import type { SessionLogger } from "../runtime/manager.js";
import {
  MONETIZATION_ACTIVATE_PRICE_ACTION,
  MONETIZATION_PAYOUT_SETTINGS_ACTION,
} from "../approvals/policy.js";
import type { BillingProvider } from "../billing/provider.js";
import { verifyWebhookSignature } from "../billing/webhook.js";
import { sanitizeTrackingRef } from "../attribution/tracking.js";
import { makeRedactor } from "../runtime/redact.js";
import {
  formatPrice,
  projectExperimentImpact,
  summarizeActivation,
  summarizePayoutSettings,
  summarizeExperimentResult,
  validatePricingDraft,
  type PlanStatus,
  type PriceInterval,
} from "./pricing.js";
import type { MonetizationCaps } from "./caps.js";

// ---- record shapes (what the store persists; the repo maps rows to these) ----------------------

export interface PlanRecord {
  id: string;
  workspaceId: string;
  ventureIdeaId: string | null;
  name: string;
  amountCents: number;
  currency: string;
  interval: PriceInterval | null;
  status: PlanStatus;
  provider: string | null;
  productId: string | null;
  priceId: string | null;
  providerLinkId: string | null;
  url: string | null;
  activationRequestId: string | null;
  previousAmountCents: number | null;
}

export type ExperimentStatus = "proposed" | "active" | "concluded" | "abandoned";

export interface ExperimentRecord {
  id: string;
  workspaceId: string;
  ventureIdeaId: string | null;
  planId: string | null;
  hypothesis: string;
  baselineAmountCents: number;
  candidateAmountCents: number;
  baselineRevenueCents: number;
  projectedDeltaCents: number;
  status: ExperimentStatus;
  activationRequestId: string | null;
  verifiedRevenueCents: number | null;
  realizedDeltaCents: number | null;
}

export interface RevenueRecord {
  id: string;
  workspaceId: string;
  ventureIdeaId: string | null;
  providerEventId: string;
  amountCents: number;
  currency: string;
  trackingRef: string | null;
  occurredAtMs: number;
}

export interface PlanStateChangeRecord {
  id: string;
  workspaceId: string;
  planId: string | null;
  fromStatus: PlanStatus;
  toStatus: PlanStatus;
  actorMemberId: string | null;
  reason: string;
  approvalRequestId: string | null;
  createdAtMs: number;
}

// ---- seams -------------------------------------------------------------------------------------

/** Durable persistence for plans/experiments/revenue. The repo implements this; tests inject fakes. */
export interface MonetizationStore {
  createPlan(input: {
    workspaceId: string;
    ventureIdeaId: string | null;
    name: string;
    amountCents: number;
    currency: string;
    interval: PriceInterval | null;
    createdByMemberId: string | null;
  }): Promise<PlanRecord>;
  getPlan(workspaceId: string, id: string): Promise<PlanRecord | undefined>;
  listPlans(
    workspaceId: string,
    filter?: { ventureIdeaId?: string | null; status?: PlanStatus; limit?: number },
  ): Promise<PlanRecord[]>;
  updatePlan(
    workspaceId: string,
    id: string,
    patch: Partial<{
      amountCents: number;
      status: PlanStatus;
      provider: string | null;
      productId: string | null;
      priceId: string | null;
      providerLinkId: string | null;
      url: string | null;
      activationRequestId: string | null;
      previousAmountCents: number | null;
      activatedAtMs: number | null;
    }>,
  ): Promise<PlanRecord | undefined>;
  recordPlanStateChange(input: {
    workspaceId: string;
    planId: string;
    fromStatus: PlanStatus;
    toStatus: PlanStatus;
    actorMemberId: string | null;
    reason: string;
    approvalRequestId: string | null;
    createdAtMs: number;
  }): Promise<PlanStateChangeRecord>;
  listPlanStateChanges(
    workspaceId: string,
    filter?: { planId?: string | null; sinceMs?: number; untilMs?: number; limit?: number },
  ): Promise<PlanStateChangeRecord[]>;

  createExperiment(input: {
    workspaceId: string;
    ventureIdeaId: string | null;
    planId: string | null;
    hypothesis: string;
    baselineAmountCents: number;
    candidateAmountCents: number;
    baselineRevenueCents: number;
    projectedDeltaCents: number;
    createdByMemberId: string | null;
  }): Promise<ExperimentRecord>;
  getExperiment(workspaceId: string, id: string): Promise<ExperimentRecord | undefined>;
  listExperiments(
    workspaceId: string,
    filter?: { ventureIdeaId?: string | null; limit?: number },
  ): Promise<ExperimentRecord[]>;
  updateExperiment(
    workspaceId: string,
    id: string,
    patch: Partial<{
      status: ExperimentStatus;
      activationRequestId: string | null;
      verifiedRevenueCents: number | null;
      realizedDeltaCents: number | null;
      concludedAtMs: number | null;
    }>,
  ): Promise<ExperimentRecord | undefined>;

  /** Idempotent insert of a verified per-venture revenue receipt; `deduped` when the event id repeats. */
  recordRevenue(input: {
    workspaceId: string;
    ventureIdeaId: string | null;
    providerEventId: string;
    type: string;
    amountCents: number;
    currency: string;
    status: string;
    trackingRef?: string | null;
    raw: string;
    occurredAtMs: number;
  }): Promise<{ deduped: boolean; revenue: RevenueRecord }>;
  /** Verified revenue for a venture since `sinceMs` (for concluding an experiment over its window). */
  sumVentureRevenue(workspaceId: string, ventureIdeaId: string, sinceMs?: number): Promise<number>;
}

/**
 * The per-venture Stripe credential vault (#192). `resolve` returns the venture's OWN Stripe secret +
 * webhook secret (keyed `stripe:<ventureIdeaId>`), or `{}` when not connected/revoked. NEVER ipop's key.
 */
export interface VentureStripeResolver {
  /** Whether the venture has a connected Stripe account (the default-OFF-per-venture gate). */
  isConnected(workspaceId: string, ventureIdeaId: string): Promise<boolean>;
  /** Resolve the venture's Stripe secrets for injection into a provider call — the only read-back path. */
  resolve(workspaceId: string, ventureIdeaId: string): Promise<Record<string, string>>;
  /** Connect (human-once) the venture's Stripe credentials into the write-only vault. */
  connect(input: {
    workspaceId: string;
    ventureIdeaId: string;
    secrets: Record<string, string>;
    connectedByMemberId?: string | null;
  }): Promise<void>;
}

/** The #13 money-decision gate (same shape as the #187 `FactoryApprovalGate`). */
export interface MoneyDecisionGate {
  submit(input: {
    workspaceId: string;
    requesterMemberId: string;
    actionKind: string;
    summary: string;
    amountCents?: number | null;
    payload: Record<string, unknown>;
  }): Promise<{ id: string }>;
  status(approvalRequestId: string): Promise<ApprovalStatus | undefined>;
}

export interface MonetizationServiceDeps {
  store: MonetizationStore;
  vault: VentureStripeResolver;
  gate: MoneyDecisionGate;
  /** The inbound-only #98 provider used to mint a REAL hosted payment link on owner-approved activation. */
  billing: BillingProvider;
  caps: (workspaceId: string) => MonetizationCaps;
  /** The workspace owner (for `ownerWorkspaceOnly`); null when unknown. */
  ownerWorkspaceId?: (workspaceId: string) => Promise<string | null>;
  logger?: SessionLogger;
  now?: () => Date;
}

// ---- typed errors ------------------------------------------------------------------------------

export class MonetizationDisabledError extends Error {
  constructor(reason: string) {
    super(`monetization refused: ${reason}`);
    this.name = "MonetizationDisabledError";
  }
}

export class PlanNotFoundError extends Error {
  constructor(id: string) {
    super(`monetization plan not found: ${id}`);
    this.name = "PlanNotFoundError";
  }
}

export class ExperimentNotFoundError extends Error {
  constructor(id: string) {
    super(`monetization experiment not found: ${id}`);
    this.name = "ExperimentNotFoundError";
  }
}

/** A venture must connect its OWN Stripe account before anything can charge against it. */
export class VentureStripeNotConnectedError extends Error {
  constructor(ventureIdeaId: string) {
    super(`venture has no connected Stripe account: ${ventureIdeaId}`);
    this.name = "VentureStripeNotConnectedError";
  }
}

const STRIPE_SECRET_KEY = "STRIPE_SECRET_KEY";
const STRIPE_WEBHOOK_SECRET = "STRIPE_WEBHOOK_SECRET";

export class MonetizationService {
  private readonly deps: MonetizationServiceDeps;
  private readonly now: () => Date;

  constructor(deps: MonetizationServiceDeps) {
    this.deps = deps;
    this.now = deps.now ?? (() => new Date());
  }

  /** Assert monetization may run in this workspace (enabled + owner-scope). */
  private async assertEnabled(workspaceId: string, caps: MonetizationCaps): Promise<void> {
    if (!caps.enabled) throw new MonetizationDisabledError("monetization.enabled is false");
    if (caps.ownerWorkspaceOnly && this.deps.ownerWorkspaceId) {
      const owner = await this.deps.ownerWorkspaceId(workspaceId);
      if (owner !== null && owner !== workspaceId) {
        throw new MonetizationDisabledError("ownerWorkspaceOnly: not the owner workspace");
      }
    }
  }

  private requireVenture(ventureIdeaId: string | null): string {
    if (!ventureIdeaId) throw new MonetizationDisabledError("ventureIdeaId required");
    return ventureIdeaId;
  }

  /**
   * Connect a venture's OWN Stripe account (#188 human-once setup). Writes the secret key (+ optional
   * webhook secret) into the #192 write-only vault keyed `stripe:<ventureIdeaId>` — never ipop's key.
   * This is the per-venture default-OFF switch: nothing can charge until the owner connects.
   */
  async connectVentureStripe(input: {
    workspaceId: string;
    ventureIdeaId: string;
    secretKey: string;
    webhookSecret?: string;
    connectedByMemberId?: string | null;
  }): Promise<void> {
    const caps = this.deps.caps(input.workspaceId);
    await this.assertEnabled(input.workspaceId, caps);
    const secrets: Record<string, string> = { [STRIPE_SECRET_KEY]: input.secretKey };
    if (input.webhookSecret) secrets[STRIPE_WEBHOOK_SECRET] = input.webhookSecret;
    await this.deps.vault.connect({
      workspaceId: input.workspaceId,
      ventureIdeaId: input.ventureIdeaId,
      secrets,
      connectedByMemberId: input.connectedByMemberId ?? null,
    });
  }

  /**
   * Draft a pricing plan for a venture (#188 AC1). Reversible and money-free — persisted `draft`, no Stripe
   * object, no #13 gate. Validates the shape via the pure `validatePricingDraft`. The currency defaults to
   * the workspace's monetization default.
   */
  async draftPlan(input: {
    workspaceId: string;
    ventureIdeaId: string;
    name: string;
    amountCents: number;
    currency?: string;
    interval?: PriceInterval | null;
    createdByMemberId?: string | null;
  }): Promise<PlanRecord> {
    const caps = this.deps.caps(input.workspaceId);
    await this.assertEnabled(input.workspaceId, caps);
    const currency = (input.currency ?? caps.defaultCurrency).toLowerCase();
    const interval = input.interval ?? null;
    const check = validatePricingDraft({ name: input.name, amountCents: input.amountCents, currency, interval });
    if (!check.ok) throw new MonetizationDisabledError(check.error);
    return this.deps.store.createPlan({
      workspaceId: input.workspaceId,
      ventureIdeaId: input.ventureIdeaId,
      name: input.name,
      amountCents: input.amountCents,
      currency,
      interval,
      createdByMemberId: input.createdByMemberId ?? null,
    });
  }

  /** List a workspace's pricing plans (workspace-scoped, optionally per-venture). */
  async listPlans(workspaceId: string, ventureIdeaId?: string | null): Promise<PlanRecord[]> {
    const caps = this.deps.caps(workspaceId);
    return this.deps.store.listPlans(workspaceId, { ventureIdeaId, limit: caps.listLimit });
  }

  /** List queryable plan status transitions for a workspace/time range (#890). */
  async listPlanStateChanges(
    workspaceId: string,
    filter?: { planId?: string | null; sinceMs?: number; untilMs?: number; limit?: number },
  ): Promise<PlanStateChangeRecord[]> {
    const caps = this.deps.caps(workspaceId);
    return this.deps.store.listPlanStateChanges(workspaceId, { ...filter, limit: filter?.limit ?? caps.listLimit });
  }

  /**
   * Queue the MONEY decision to activate a draft plan so customers can be charged (#188 AC2). Asserts the
   * venture connected its OWN Stripe account first, builds the EXACT-amount summary, submits a #13
   * `monetization.activate_price` request (sensitive by default), and parks the plan `pending_activation`
   * with the request id. The requester MUST be an agent member — the owner approves it (self-approval is
   * forbidden by #13). A live link is minted only after that approval (by {@link activatePending}).
   */
  async requestActivation(input: {
    workspaceId: string;
    planId: string;
    requesterMemberId: string;
    ventureName: string;
  }): Promise<{ approvalRequestId: string; plan: PlanRecord }> {
    const caps = this.deps.caps(input.workspaceId);
    await this.assertEnabled(input.workspaceId, caps);
    const plan = await this.deps.store.getPlan(input.workspaceId, input.planId);
    if (!plan) throw new PlanNotFoundError(input.planId);
    const ventureIdeaId = this.requireVenture(plan.ventureIdeaId);
    if (!(await this.deps.vault.isConnected(input.workspaceId, ventureIdeaId))) {
      throw new VentureStripeNotConnectedError(ventureIdeaId);
    }

    const previousAmountCents = plan.status === "active" ? plan.amountCents : null;
    const summary = summarizeActivation({
      ventureName: input.ventureName,
      planName: plan.name,
      amountCents: plan.amountCents,
      currency: plan.currency,
      interval: plan.interval,
      previousAmountCents,
    });
    const req = await this.deps.gate.submit({
      workspaceId: input.workspaceId,
      requesterMemberId: input.requesterMemberId,
      actionKind: MONETIZATION_ACTIVATE_PRICE_ACTION,
      summary,
      // The price the owner is approving — drives the #13 amount gate AND is shown on the Slack card.
      amountCents: plan.amountCents,
      payload: {
        planId: plan.id,
        ventureName: input.ventureName,
        amountCents: plan.amountCents,
        currency: plan.currency,
        previousAmountCents,
      },
    });
    const updated =
      (await this.deps.store.updatePlan(input.workspaceId, plan.id, {
        status: "pending_activation",
        activationRequestId: req.id,
        previousAmountCents,
      })) ?? plan;
    return { approvalRequestId: req.id, plan: updated };
  }

  /**
   * Mint the REAL hosted payment links for every plan whose activation the owner has approved (#188 AC2).
   * The engine calls this each tick: for each `pending_activation` plan whose #13 request is `executed`
   * (the owner approved), it resolves the venture's OWN Stripe key from the vault and creates a product +
   * price + payment link through the inbound-only #98 provider (collection only — never a payout), then
   * flips the plan `active`. Idempotent, per-plan isolated, and a no-op when nothing is approved.
   */
  async activatePending(workspaceId: string): Promise<{ activated: string[] }> {
    const caps = this.deps.caps(workspaceId);
    if (!caps.enabled) return { activated: [] };
    const pending = await this.deps.store.listPlans(workspaceId, {
      status: "pending_activation",
      limit: caps.listLimit,
    });
    const activated: string[] = [];
    for (const plan of pending) {
      if (!plan.activationRequestId) continue;
      try {
        const status = await this.deps.gate.status(plan.activationRequestId);
        if (status !== "executed") continue; // not yet approved → leave it parked.
        const ventureIdeaId = this.requireVenture(plan.ventureIdeaId);
        const secrets = await this.deps.vault.resolve(workspaceId, ventureIdeaId);
        if (!secrets[STRIPE_SECRET_KEY]) {
          this.deps.logger?.warn({ workspaceId, planId: plan.id }, "monetization: venture stripe not connected at activation");
          continue;
        }
        const minted = await this.mintLink(workspaceId, plan, secrets);
        const fromStatus = plan.status;
        const activatedAtMs = this.now().getTime();
        await this.deps.store.updatePlan(workspaceId, plan.id, {
          status: "active",
          provider: this.deps.billing.kind,
          productId: minted.productId,
          priceId: minted.priceId,
          providerLinkId: minted.providerLinkId,
          url: minted.url,
          activatedAtMs,
        });
        await this.deps.store.recordPlanStateChange({
          workspaceId,
          planId: plan.id,
          fromStatus,
          toStatus: "active",
          actorMemberId: null,
          reason: "owner_approved_activation",
          approvalRequestId: plan.activationRequestId,
          createdAtMs: activatedAtMs,
        });
        // If an experiment drove this re-price, mark it live now (its result is concluded later from receipts).
        const experiments = await this.deps.store.listExperiments(workspaceId, {
          ventureIdeaId: plan.ventureIdeaId,
          limit: caps.listLimit,
        });
        for (const exp of experiments) {
          if (exp.planId === plan.id && exp.activationRequestId === plan.activationRequestId && exp.status === "proposed") {
            await this.deps.store.updateExperiment(workspaceId, exp.id, { status: "active" });
          }
        }
        activated.push(plan.id);
      } catch (err) {
        // Isolated: one plan's provider failure never stalls the others. The plan stays pending for retry.
        this.deps.logger?.error({ workspaceId, planId: plan.id, err }, "monetization: activation failed");
      }
    }
    return { activated };
  }

  /** Mint a product + price + payment link through the inbound-only #98 provider (collection only). */
  private async mintLink(
    workspaceId: string,
    plan: PlanRecord,
    secrets: Record<string, string>,
  ): Promise<{ productId: string; priceId: string; providerLinkId: string; url: string }> {
    const redact = makeRedactor(secrets);
    try {
      const pp = await this.deps.billing.createProductPrice({
        name: plan.name,
        amountCents: plan.amountCents,
        currency: plan.currency,
        interval: plan.interval,
        secrets,
      });
      const link = await this.deps.billing.createPaymentLink({
        priceId: pp.priceId,
        slug: `venture-${plan.ventureIdeaId ?? "ws"}-${plan.id}`.replace(/[^a-zA-Z0-9-]/g, "-").toLowerCase(),
        metadata: {
          workspaceId,
          planId: plan.id,
          ...(plan.ventureIdeaId ? { ventureIdeaId: plan.ventureIdeaId } : {}),
        },
        secrets,
      });
      return { productId: pp.productId, priceId: pp.priceId, providerLinkId: link.providerLinkId, url: link.url };
    } catch (err) {
      throw new Error(redact(err instanceof Error ? err.message : String(err)));
    }
  }

  /**
   * Propose a pricing experiment (#188 AC3). A lens/bid supplies the baseline + candidate price and its
   * conversion hypothesis; the pure `projectExperimentImpact` computes a clearly UNVERIFIED projection
   * stored on the row. No money moves and no #13 gate yet — activation is a separate owner decision.
   */
  async proposeExperiment(input: {
    workspaceId: string;
    ventureIdeaId: string;
    planId?: string | null;
    hypothesis: string;
    baselineAmountCents: number;
    candidateAmountCents: number;
    baselineConversions: number;
    candidateConversions: number;
    createdByMemberId?: string | null;
  }): Promise<{ experiment: ExperimentRecord; projection: ReturnType<typeof projectExperimentImpact> }> {
    const caps = this.deps.caps(input.workspaceId);
    await this.assertEnabled(input.workspaceId, caps);
    const projection = projectExperimentImpact({
      baselineAmountCents: input.baselineAmountCents,
      candidateAmountCents: input.candidateAmountCents,
      baselineConversions: input.baselineConversions,
      candidateConversions: input.candidateConversions,
    });
    const experiment = await this.deps.store.createExperiment({
      workspaceId: input.workspaceId,
      ventureIdeaId: input.ventureIdeaId,
      planId: input.planId ?? null,
      hypothesis: input.hypothesis,
      baselineAmountCents: input.baselineAmountCents,
      candidateAmountCents: input.candidateAmountCents,
      baselineRevenueCents: projection.baselineRevenueCents,
      projectedDeltaCents: projection.deltaCents,
      createdByMemberId: input.createdByMemberId ?? null,
    });
    return { experiment, projection };
  }

  /** List a workspace's pricing experiments (workspace-scoped, optionally per-venture). */
  async listExperiments(workspaceId: string, ventureIdeaId?: string | null): Promise<ExperimentRecord[]> {
    const caps = this.deps.caps(workspaceId);
    return this.deps.store.listExperiments(workspaceId, { ventureIdeaId, limit: caps.listLimit });
  }

  /**
   * Queue the MONEY decision to run an experiment — re-pricing its target plan to the candidate price
   * (#188 AC3). Requires a linked `planId`. Stages the plan at the candidate price (`pending_activation`,
   * `previous_amount_cents` = the old price), submits one #13 `monetization.activate_price` decision with
   * the before→after shown, and links it on both the plan and the experiment. The owner's yes is required;
   * the engine then mints the new link. Self-approval is forbidden (the requester must be an agent member).
   */
  async requestExperimentActivation(input: {
    workspaceId: string;
    experimentId: string;
    requesterMemberId: string;
    ventureName: string;
  }): Promise<{ approvalRequestId: string }> {
    const caps = this.deps.caps(input.workspaceId);
    await this.assertEnabled(input.workspaceId, caps);
    const exp = await this.deps.store.getExperiment(input.workspaceId, input.experimentId);
    if (!exp) throw new ExperimentNotFoundError(input.experimentId);
    if (!exp.planId) throw new MonetizationDisabledError("experiment has no target plan to re-price");
    const plan = await this.deps.store.getPlan(input.workspaceId, exp.planId);
    if (!plan) throw new PlanNotFoundError(exp.planId);
    const ventureIdeaId = this.requireVenture(plan.ventureIdeaId);
    if (!(await this.deps.vault.isConnected(input.workspaceId, ventureIdeaId))) {
      throw new VentureStripeNotConnectedError(ventureIdeaId);
    }

    const previousAmountCents = plan.amountCents;
    const summary = summarizeActivation({
      ventureName: input.ventureName,
      planName: plan.name,
      amountCents: exp.candidateAmountCents,
      currency: plan.currency,
      interval: plan.interval,
      previousAmountCents,
    });
    const req = await this.deps.gate.submit({
      workspaceId: input.workspaceId,
      requesterMemberId: input.requesterMemberId,
      actionKind: MONETIZATION_ACTIVATE_PRICE_ACTION,
      summary,
      amountCents: exp.candidateAmountCents,
      payload: {
        planId: plan.id,
        experimentId: exp.id,
        ventureName: input.ventureName,
        amountCents: exp.candidateAmountCents,
        currency: plan.currency,
        previousAmountCents,
      },
    });
    await this.deps.store.updatePlan(input.workspaceId, plan.id, {
      amountCents: exp.candidateAmountCents,
      status: "pending_activation",
      activationRequestId: req.id,
      previousAmountCents,
    });
    await this.deps.store.updateExperiment(input.workspaceId, exp.id, { activationRequestId: req.id });
    return { approvalRequestId: req.id };
  }

  /**
   * Conclude an experiment with its EXTERNALLY-VERIFIED outcome (#188 AC3, premortem FM#2). Sums the
   * venture's verified revenue since `sinceMs` (from `monetization_revenue` — real Stripe receipts only),
   * computes the realized delta vs. the baseline via the pure `summarizeExperimentResult`, and records it
   * on the row. The result that lands in the scorecard is a receipt-backed fact, never the projection.
   */
  async concludeExperiment(input: {
    workspaceId: string;
    experimentId: string;
    sinceMs?: number;
  }): Promise<{ verifiedRevenueCents: number; realizedDeltaCents: number }> {
    const caps = this.deps.caps(input.workspaceId);
    await this.assertEnabled(input.workspaceId, caps);
    const exp = await this.deps.store.getExperiment(input.workspaceId, input.experimentId);
    if (!exp) throw new ExperimentNotFoundError(input.experimentId);
    const ventureIdeaId = this.requireVenture(exp.ventureIdeaId);
    const verifiedRevenueCents = await this.deps.store.sumVentureRevenue(
      input.workspaceId,
      ventureIdeaId,
      input.sinceMs,
    );
    const result = summarizeExperimentResult({
      verifiedRevenueCents,
      baselineRevenueCents: exp.baselineRevenueCents,
      projectedDeltaCents: exp.projectedDeltaCents,
    });
    await this.deps.store.updateExperiment(input.workspaceId, exp.id, {
      status: "concluded",
      verifiedRevenueCents: result.verifiedRevenueCents,
      realizedDeltaCents: result.realizedDeltaCents,
      concludedAtMs: this.now().getTime(),
    });
    return { verifiedRevenueCents: result.verifiedRevenueCents, realizedDeltaCents: result.realizedDeltaCents };
  }

  /**
   * Queue a recorded-only MONEY decision to change a venture's payout settings (#188 AC2). Re-routing money
   * is irreversible and never autonomous: this only parks the owner decision with the destination shown;
   * the owner makes the change in the venture's own Stripe dashboard. Returns the #13 request id.
   */
  async requestPayoutSettings(input: {
    workspaceId: string;
    ventureId: string;
    ventureName: string;
    destination: string;
    requesterMemberId: string;
  }): Promise<{ approvalRequestId: string }> {
    const caps = this.deps.caps(input.workspaceId);
    await this.assertEnabled(input.workspaceId, caps);
    const req = await this.deps.gate.submit({
      workspaceId: input.workspaceId,
      requesterMemberId: input.requesterMemberId,
      actionKind: MONETIZATION_PAYOUT_SETTINGS_ACTION,
      summary: summarizePayoutSettings({ ventureName: input.ventureName, destination: input.destination }),
      payload: { ventureId: input.ventureId, ventureName: input.ventureName, destination: input.destination },
    });
    return { approvalRequestId: req.id };
  }

  /**
   * Ingest a per-venture provider webhook (#188 AC4). Verifies the delivery's signature with THAT venture's
   * own webhook secret (from the vault) — throws on a forged/replayed body — then records a verified,
   * venture-attributed revenue receipt (deduped on the provider event id, the redacted body stored). This
   * is the externally-verified per-venture revenue the #194 ledger reads → the #173 weekly P&L.
   */
  async ingestVentureWebhook(input: {
    workspaceId: string;
    ventureIdeaId: string;
    rawBody: string;
    signature: string | undefined;
  }): Promise<{ deduped: boolean; revenue?: RevenueRecord }> {
    const caps = this.deps.caps(input.workspaceId);
    await this.assertEnabled(input.workspaceId, caps);
    const secrets = await this.deps.vault.resolve(input.workspaceId, input.ventureIdeaId);
    const webhookSecret = secrets[STRIPE_WEBHOOK_SECRET];
    if (!webhookSecret) throw new VentureStripeNotConnectedError(input.ventureIdeaId);
    verifyWebhookSignature(input.rawBody, input.signature, webhookSecret, {
      now: this.now(),
      toleranceSec: caps.webhookToleranceSec,
    });
    const parsed = parseWebhookEvent(input.rawBody, caps.defaultCurrency);
    const redact = makeRedactor(secrets);
    const { deduped, revenue } = await this.deps.store.recordRevenue({
      workspaceId: input.workspaceId,
      ventureIdeaId: input.ventureIdeaId,
      providerEventId: parsed.id,
      type: parsed.type,
      amountCents: parsed.amountCents,
      currency: parsed.currency,
      status: parsed.status,
      trackingRef: sanitizeTrackingRef(parsed.metadata.trackingRef),
      raw: redact(input.rawBody),
      occurredAtMs: this.now().getTime(),
    });
    return { deduped, revenue };
  }

  /** A human-readable price line for a plan (the console/scorecard surface). */
  planPriceLine(plan: PlanRecord): string {
    return formatPrice(plan.amountCents, plan.currency, plan.interval);
  }
}

// ---- pure webhook parse (no IO) ----------------------------------------------------------------

interface ParsedEvent {
  id: string;
  type: string;
  amountCents: number;
  currency: string;
  status: string;
  metadata: Record<string, string | undefined>;
}

/**
 * Tolerantly parse a provider webhook body into the fields we persist (mirrors #98's manager parse). The
 * resource is nested under `data.object`; amount may be `amount_total`/`amount`/`amount_received`. Unknown
 * fields degrade to safe defaults — a malformed-but-signed body still yields a recordable receipt.
 */
function parseWebhookEvent(rawBody: string, defaultCurrency: string): ParsedEvent {
  let obj: Record<string, unknown> = {};
  try {
    obj = JSON.parse(rawBody) as Record<string, unknown>;
  } catch {
    /* keep defaults */
  }
  const data = (obj.data as Record<string, unknown> | undefined)?.object as Record<string, unknown> | undefined;
  const amount = num(data?.amount_total) ?? num(data?.amount) ?? num(data?.amount_received) ?? 0;
  const metadata =
    data?.metadata && typeof data.metadata === "object"
      ? Object.fromEntries(
          Object.entries(data.metadata as Record<string, unknown>).map(([key, value]) => [
            key,
            typeof value === "string" ? value : undefined,
          ]),
        )
      : {};
  return {
    id: typeof obj.id === "string" && obj.id ? obj.id : "evt_unknown",
    type: typeof obj.type === "string" ? obj.type : "unknown",
    amountCents: amount,
    currency: (typeof data?.currency === "string" ? data.currency : defaultCurrency).toLowerCase(),
    status:
      (typeof data?.payment_status === "string" && data.payment_status) ||
      (typeof data?.status === "string" && data.status) ||
      "succeeded",
    metadata,
  };
}

function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
