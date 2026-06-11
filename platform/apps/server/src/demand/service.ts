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
  /**
   * Whether a refund has already been recorded for this checkout ref. The refund decision keys off THIS,
   * not the signal dedup — so a webhook retry after a partial failure (signal persisted, refund not) still
   * refunds, while a full replay (refund already recorded) does not double-refund.
   */
  exists(workspaceId: string, experimentId: string, externalRef: string): Promise<boolean>;
}

/**
 * Tenant-scoped venture-idea ownership lookup (the #19 IDOR boundary). Register/launch/signal/view verify
 * the idea/experiment belongs to the caller's workspace through this seam — a user in workspace A can never
 * attach an experiment to (or read signals against) workspace B's venture.
 */
export interface VentureLookup {
  exists(workspaceId: string, ventureIdeaId: string): Promise<boolean>;
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
  /** Tenant ownership lookup (#19 IDOR): verifies a venture idea belongs to the workspace. */
  ventures: VentureLookup;
  /** The #17 kill switch for the workspace — when engaged, no new fake-door is launched. Default: off. */
  killSwitch?: (workspaceId: string) => Promise<boolean>;
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

/** Thrown when a new fake-door launch is attempted while the #17 kill switch is engaged → route 409. */
export class DemandKillSwitchError extends Error {
  constructor(message = "kill switch engaged — refusing to launch a new smoke test") {
    super(message);
    this.name = "DemandKillSwitchError";
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

  private async killSwitchEngaged(workspaceId: string): Promise<boolean> {
    return this.deps.killSwitch ? this.deps.killSwitch(workspaceId) : false;
  }

  /** Register a **locked** experiment. The spec bar is validated here and never mutated after launch. */
  async register(input: RegisterExperimentInput): Promise<DemandExperiment> {
    validateSpec(input.spec);
    // #19 IDOR: an experiment may only attach to a venture idea in the SAME workspace.
    if (input.ventureIdeaId !== null && !(await this.deps.ventures.exists(input.workspaceId, input.ventureIdeaId))) {
      throw new DemandNotFoundError("venture idea not found in this workspace");
    }
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
  async launch(workspaceId: string, id: string, ventureIdeaId?: string): Promise<DemandExperiment> {
    const exp = await this.require(workspaceId, id, ventureIdeaId);
    if (exp.status !== "registered") {
      throw new DemandStateError(`experiment is ${exp.status}, not registered — cannot launch`);
    }
    if (exp.availability !== "available" && !(exp.disclosure ?? "").trim()) {
      throw new EthicsDisclosureError();
    }
    // #17 kill switch: launching deploys + mints a real checkout (outbound work) — gate it like an
    // autonomy launch. The ethics auto-refund in `ingestCheckout` is deliberately NOT gated (a charge
    // that already happened must always be refunded).
    if (await this.killSwitchEngaged(workspaceId)) {
      throw new DemandKillSwitchError();
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
    ventureIdeaId?: string,
  ): Promise<{ deduped: boolean }> {
    const exp = await this.require(workspaceId, id, ventureIdeaId);
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
   * the product is `available`, auto-refunds it (the ethics rail).
   *
   * The refund decision is **independent of the signal dedup**: a webhook retry after a partial failure
   * (the signal persisted but the refund crashed) hits `deduped = true`, yet the charge is still
   * unrefunded — so we re-attempt the refund whenever no `demand_refunds` row exists for the ref. A full
   * replay (a refund row already exists) never double-refunds.
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

    // Ethics rail: a pre-availability charge must be refunded — keyed off whether a refund was already
    // recorded for this ref, NOT off the signal dedup (so a retry after a partial failure still refunds).
    let refunded = false;
    if (exp.availability !== "available") {
      const alreadyRefunded = await this.deps.refunds.exists(
        input.workspaceId,
        input.experimentId,
        input.externalRef,
      );
      if (!alreadyRefunded) {
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
        refunded = true;
      }
    }
    return { deduped, refunded };
  }

  /** Read the experiment, its funnel, and the verdict against the locked bar. */
  async view(workspaceId: string, id: string, ventureIdeaId?: string): Promise<ExperimentView> {
    const exp = await this.require(workspaceId, id, ventureIdeaId);
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

  /**
   * Load an experiment scoped to the workspace (cross-workspace ids 404 — the store filters by
   * `workspace_id`). When `expectedVentureIdeaId` is supplied (the route's path `:vid`), the experiment's
   * own `ventureIdeaId` must match it — so an experiment can never be read/mutated through the wrong
   * venture's URL (#19 IDOR).
   */
  private async require(
    workspaceId: string,
    id: string,
    expectedVentureIdeaId?: string,
  ): Promise<DemandExperiment> {
    const exp = await this.deps.experiments.get(workspaceId, id);
    if (!exp) throw new DemandNotFoundError();
    if (expectedVentureIdeaId !== undefined && exp.ventureIdeaId !== expectedVentureIdeaId) {
      throw new DemandNotFoundError();
    }
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
