import {
  externalDemandEvidence,
  type DemandSignal,
  type DemandSignalClass,
  type ExternalDemandEvidence,
  type ExternalSource,
} from "./provenance.js";
import { aggregateFunnel, type Funnel } from "./signals.js";
import {
  evaluateExperiment,
  validateSpec,
  type ExperimentEvaluation,
  type ExperimentSpec,
} from "./experiment.js";

/**
 * DemandValidationService (#101, ADR-0101) — the IO orchestrator for the fake-door smoke test pipeline,
 * modelled on the #96 VentureService: side effects here, the pure provenance/funnel/experiment logic in
 * `provenance.ts`/`signals.ts`/`experiment.ts`. Every collaborator is an injected seam so the loop is
 * unit-tested over fakes (no DB, no deploy, no money); `default.ts` wires production.
 *
 * The pipeline: register a **locked** experiment → launch a fake-door landing + a real #98 checkout →
 * capture funnel signals (the apex `paid` arrives through the #98 signature-verified webhook) → evaluate
 * against the locked bar. The ethics rail refuses to launch a pre-launch checkout without a disclosure and
 * auto-refunds a charge that lands before availability.
 */

export type Availability = "available" | "waitlist" | "preorder";

export interface DemandExperiment {
  id: string;
  workspaceId: string;
  ventureIdeaId: string | null;
  hypothesis: string;
  successClass: DemandSignalClass;
  denominatorClass: DemandSignalClass;
  passThreshold: number;
  minSample: number;
  windowStartMs: number;
  windowEndMs: number;
  availability: Availability;
  disclosure: string | null;
  status: "registered" | "live" | "concluded";
  landingUrl: string | null;
  checkoutUrl: string | null;
  createdByMemberId: string | null;
  createdAt: Date;
}

export interface RegisterExperimentInput {
  workspaceId: string;
  ventureIdeaId: string | null;
  spec: ExperimentSpec;
  availability: Availability;
  /** Required at launch for a pre-launch (`waitlist`/`preorder`) checkout — the ethics disclosure. */
  disclosure: string | null;
  createdByMemberId: string | null;
}

export interface RecordSignalInput {
  workspaceId: string;
  experimentId: string;
  ventureIdeaId: string | null;
  signalClass: DemandSignalClass;
  source: ExternalSource;
  externalRef: string;
  amountCents: number;
  currency: string;
}

/** Persistence seam for the locked experiment spec + lifecycle (DB repo in prod; in-memory in tests). */
export interface ExperimentStore {
  create(input: Omit<DemandExperiment, "id" | "status" | "landingUrl" | "checkoutUrl" | "createdAt">): Promise<DemandExperiment>;
  get(workspaceId: string, id: string): Promise<DemandExperiment | undefined>;
  list(workspaceId: string, ventureIdeaId?: string): Promise<DemandExperiment[]>;
  markLive(workspaceId: string, id: string, landingUrl: string, checkoutUrl: string): Promise<DemandExperiment>;
}

/** Persistence seam for externally-attributed funnel signals (deduped on the external ref). */
export interface SignalStore {
  /** Append a signal; idempotent on `(workspace, experiment, externalRef)` — a replay is `deduped`. */
  record(input: RecordSignalInput): Promise<{ deduped: boolean }>;
  list(workspaceId: string, experimentId: string): Promise<DemandSignal[]>;
  listForIdea(workspaceId: string, ventureIdeaId: string): Promise<DemandSignal[]>;
}

/** Ethics auto-refund audit seam. */
export interface RefundStore {
  record(input: {
    workspaceId: string;
    experimentId: string;
    externalRef: string;
    amountCents: number;
    currency: string;
    reason: string;
  }): Promise<void>;
}

/** Fake-door landing deploy seam — composes the #73 DeployProvider in production. */
export interface LandingDeployer {
  deploy(input: {
    workspaceId: string;
    experimentId: string;
    hypothesis: string;
    disclosure: string | null;
  }): Promise<{ url: string }>;
}

/** Checkout mint seam — composes the #98/#125 payment-link rails in production. */
export interface CheckoutMinter {
  mint(input: {
    workspaceId: string;
    experimentId: string;
    ventureIdeaId: string | null;
    amountCents: number;
    currency: string;
  }): Promise<{ url: string }>;
}

/** Instant-refund seam — composes the provider refund in production (recorded-only, #13-gated outbound). */
export interface Refunder {
  refund(input: { workspaceId: string; externalRef: string; amountCents: number; currency: string }): Promise<void>;
}

export interface DemandServiceDeps {
  experiments: ExperimentStore;
  signals: SignalStore;
  refunds: RefundStore;
  deployer: LandingDeployer;
  checkout: CheckoutMinter;
  refunder: Refunder;
  /** Default checkout amount (cents) for the smoke test when not specified. */
  defaultAmountCents?: number;
  defaultCurrency?: string;
  now?: () => Date;
}

/** Thrown when an experiment does not exist for the workspace → route 404. */
export class DemandNotFoundError extends Error {
  constructor(message = "demand experiment not found") {
    super(message);
    this.name = "DemandNotFoundError";
  }
}

/** Thrown when an operation is invalid for the experiment's lifecycle state → route 409. */
export class DemandStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DemandStateError";
  }
}

/** Thrown when a pre-launch checkout would launch without the required ethics disclosure → route 409. */
export class EthicsDisclosureError extends Error {
  constructor(message = "a pre-launch (waitlist/preorder) checkout must disclose its status before launch") {
    super(message);
    this.name = "EthicsDisclosureError";
  }
}

export interface ExperimentView {
  experiment: DemandExperiment;
  funnel: Funnel;
  evaluation: ExperimentEvaluation;
}

export interface IngestCheckoutResult {
  deduped: boolean;
  /** True when the charge landed before availability and was auto-refunded (the ethics rail). */
  refunded: boolean;
}

/** Map a funnel-stage class to the external source recorded on its attribution. */
export function sourceForClass(signalClass: DemandSignalClass): ExternalSource {
  switch (signalClass) {
    case "visit":
      return "landing_visit";
    case "cta_click":
      return "cta_click";
    case "checkout_started":
      return "checkout_started";
    case "waitlist":
      return "waitlist_signup";
    case "paid":
      return "checkout";
  }
}

export class DemandValidationService {
  constructor(private readonly deps: DemandServiceDeps) {}

  private now(): Date {
    return (this.deps.now ?? (() => new Date()))();
  }

  /** Register a **locked** experiment. The spec bar is validated here and never mutated after launch. */
  async register(input: RegisterExperimentInput): Promise<DemandExperiment> {
    validateSpec(input.spec);
    return this.deps.experiments.create({
      workspaceId: input.workspaceId,
      ventureIdeaId: input.ventureIdeaId,
      hypothesis: input.spec.hypothesis,
      successClass: input.spec.successClass,
      denominatorClass: input.spec.denominatorClass,
      passThreshold: input.spec.passThreshold,
      minSample: input.spec.minSample,
      windowStartMs: input.spec.windowStartMs,
      windowEndMs: input.spec.windowEndMs,
      availability: input.availability,
      disclosure: input.disclosure,
      createdByMemberId: input.createdByMemberId,
    });
  }

  /**
   * Launch the fake-door: deploy the landing page + mint the real checkout. The ethics rail refuses a
   * pre-launch (`waitlist`/`preorder`) launch with no disclosure; re-launching a live experiment is a 409.
   */
  async launch(workspaceId: string, id: string): Promise<DemandExperiment> {
    const exp = await this.require(workspaceId, id);
    if (exp.status !== "registered") {
      throw new DemandStateError(`experiment is ${exp.status}, not registered — cannot launch`);
    }
    if (exp.availability !== "available" && !(exp.disclosure ?? "").trim()) {
      throw new EthicsDisclosureError();
    }
    const landing = await this.deps.deployer.deploy({
      workspaceId,
      experimentId: id,
      hypothesis: exp.hypothesis,
      disclosure: exp.disclosure,
    });
    const checkout = await this.deps.checkout.mint({
      workspaceId,
      experimentId: id,
      ventureIdeaId: exp.ventureIdeaId,
      amountCents: this.deps.defaultAmountCents ?? 2000,
      currency: this.deps.defaultCurrency ?? "usd",
    });
    return this.deps.experiments.markLive(workspaceId, id, landing.url, checkout.url);
  }

  /** Capture a funnel signal (visit / cta_click / checkout_started / waitlist). Deduped on `externalRef`. */
  async recordSignal(
    workspaceId: string,
    id: string,
    signalClass: Exclude<DemandSignalClass, "paid">,
    externalRef: string,
    opts: { amountCents?: number; currency?: string } = {},
  ): Promise<{ deduped: boolean }> {
    const exp = await this.require(workspaceId, id);
    return this.deps.signals.record({
      workspaceId,
      experimentId: id,
      ventureIdeaId: exp.ventureIdeaId,
      signalClass,
      source: sourceForClass(signalClass),
      externalRef,
      amountCents: opts.amountCents ?? 0,
      currency: opts.currency ?? "usd",
    });
  }

  /**
   * Ingest the apex external signal — a real, signature-verified checkout from the #98 webhook. Records a
   * `paid` funnel signal (externally attributed by the Stripe event id) and, if the charge arrived before
   * the product is `available`, auto-refunds it (the ethics rail). Idempotent: a replayed event is
   * `deduped` and never double-refunds.
   */
  async ingestCheckout(input: {
    workspaceId: string;
    experimentId: string;
    externalRef: string;
    amountCents: number;
    currency: string;
  }): Promise<IngestCheckoutResult> {
    const exp = await this.require(input.workspaceId, input.experimentId);
    const { deduped } = await this.deps.signals.record({
      workspaceId: input.workspaceId,
      experimentId: input.experimentId,
      ventureIdeaId: exp.ventureIdeaId,
      signalClass: "paid",
      source: "checkout",
      externalRef: input.externalRef,
      amountCents: input.amountCents,
      currency: input.currency,
    });
    // Only act on the first delivery — a webhook replay must not refund twice.
    if (deduped) return { deduped: true, refunded: false };

    if (exp.availability !== "available") {
      await this.deps.refunder.refund({
        workspaceId: input.workspaceId,
        externalRef: input.externalRef,
        amountCents: input.amountCents,
        currency: input.currency,
      });
      await this.deps.refunds.record({
        workspaceId: input.workspaceId,
        experimentId: input.experimentId,
        externalRef: input.externalRef,
        amountCents: input.amountCents,
        currency: input.currency,
        reason: `charged before availability (${exp.availability}) — auto-refunded`,
      });
      return { deduped: false, refunded: true };
    }
    return { deduped: false, refunded: false };
  }

  /** Read the experiment, its funnel, and the verdict against the locked bar. */
  async view(workspaceId: string, id: string): Promise<ExperimentView> {
    const exp = await this.require(workspaceId, id);
    const signals = await this.deps.signals.list(workspaceId, id);
    const funnel = aggregateFunnel(signals);
    const evaluation = evaluateExperiment(this.spec(exp), funnel, this.now().getTime());
    return { experiment: exp, funnel, evaluation };
  }

  async list(workspaceId: string, ventureIdeaId?: string): Promise<DemandExperiment[]> {
    return this.deps.experiments.list(workspaceId, ventureIdeaId);
  }

  /**
   * The {@link ExternalDemandEvidence} an idea has earned — the #96 demand-overlay source. Every signal in
   * the store is externally attributed, but each is re-validated through the branded constructor so only
   * provably-external evidence ever reaches the scorecard (a blank ref is dropped).
   */
  async externalDemandEvidence(
    workspaceId: string,
    ventureIdeaId: string,
  ): Promise<ExternalDemandEvidence[]> {
    const signals = await this.deps.signals.listForIdea(workspaceId, ventureIdeaId);
    const out: ExternalDemandEvidence[] = [];
    for (const s of signals) {
      const ev = externalDemandEvidence(s);
      if (ev) out.push(ev);
    }
    return out;
  }

  // --- internals ---

  private async require(workspaceId: string, id: string): Promise<DemandExperiment> {
    const exp = await this.deps.experiments.get(workspaceId, id);
    if (!exp) throw new DemandNotFoundError();
    return exp;
  }

  private spec(exp: DemandExperiment): ExperimentSpec {
    return {
      hypothesis: exp.hypothesis,
      successClass: exp.successClass,
      denominatorClass: exp.denominatorClass,
      passThreshold: exp.passThreshold,
      minSample: exp.minSample,
      windowStartMs: exp.windowStartMs,
      windowEndMs: exp.windowEndMs,
    };
  }
}

/** The #96 ↔ #101 seam type the VentureService consumes for the demand overlay. */
export interface DemandEvidenceSource {
  externalDemandEvidence(workspaceId: string, ideaId: string): Promise<ExternalDemandEvidence[]>;
}
