/**
 * Typed evidence provenance for Demand Validation Rails (#101, ADR-0101) — the architectural core.
 *
 * The Venture Loop (#96) scores fundability with two LLM personas; for the **demand** dimension that is
 * circular (an LLM grading an LLM is not evidence a stranger will pay). This module draws the line the
 * scorecard's demand dimension must respect, and makes it **structural, not convention** (the #119
 * invariant-class pattern): a demand score backed by self-generated evidence is *unconstructable*.
 *
 * `EvidenceProvenance` is a discriminated union — `self_generated` (an internal heuristic or persona) vs
 * `externally_attributed` (a real outside actor, carrying a non-empty `externalRef` from outside the
 * building). The branded {@link ExternalDemandEvidence} is the only thing the demand dimension consumes,
 * and its sole constructor {@link externalDemandEvidence} returns `null` for self-generated provenance.
 */

/** The funnel stages, also the demand-signal classes: visits → CTA clicks → checkout starts → paid. */
export type DemandSignalClass = "visit" | "cta_click" | "checkout_started" | "waitlist" | "paid";

/** Strength-ordered (weakest → strongest); `paid` is the apex willingness-to-pay signal. */
export const DEMAND_SIGNAL_CLASSES: readonly DemandSignalClass[] = [
  "visit",
  "cta_click",
  "checkout_started",
  "waitlist",
  "paid",
] as const;

/** Where an externally-attributed action happened — the funnel touchpoint that produced the signal. */
export type ExternalSource =
  | "landing_visit"
  | "cta_click"
  | "checkout_started"
  | "waitlist_signup"
  | "checkout"
  | "deposit";

/**
 * Proof an action came from outside the building. `externalRef` is a non-empty id minted by an external
 * system (a Stripe event id for a real charge, an anonymized visitor token for a landing visit) — the
 * thing that makes the signal *attributable to a stranger* rather than to us.
 */
export interface ExternalAttribution {
  source: ExternalSource;
  /** A non-empty id from the external system. A blank ref is not attributable (see {@link externalDemandEvidence}). */
  externalRef: string;
}

/** The provenance of a piece of demand evidence — the typed self-vs-external boundary. */
export type EvidenceProvenance =
  | { kind: "self_generated"; generator: string }
  | { kind: "externally_attributed"; attribution: ExternalAttribution };

/** One demand signal: a funnel-stage class, its provenance, and (for `paid`) the amount. */
export interface DemandSignal {
  signalClass: DemandSignalClass;
  provenance: EvidenceProvenance;
  amountCents: number;
  currency: string;
}

/** Narrow a provenance to the externally-attributed variant. */
export function isExternallyAttributed(
  p: EvidenceProvenance,
): p is { kind: "externally_attributed"; attribution: ExternalAttribution } {
  return p.kind === "externally_attributed";
}

declare const EXTERNAL_DEMAND_BRAND: unique symbol;

/**
 * A demand signal **proven to come from outside the building** — the only thing the scorecard's demand
 * dimension may consume. The brand is unforgeable: the sole constructor is {@link externalDemandEvidence}.
 * There is no way to obtain an `ExternalDemandEvidence` for a self-generated signal, so the compiler
 * refuses to feed circular evidence into a demand score.
 */
export type ExternalDemandEvidence = DemandSignal & { readonly [EXTERNAL_DEMAND_BRAND]: true };

/** Thrown when self-generated (circular) evidence is presented where external evidence is required. */
export class CircularEvidenceError extends Error {
  constructor(detail = "demand evidence must be externally attributed (circular evidence rejected)") {
    super(detail);
    this.name = "CircularEvidenceError";
  }
}

/**
 * The sole constructor of {@link ExternalDemandEvidence}. Returns the branded evidence for a signal that
 * is externally attributed **with a non-empty `externalRef`**, or `null` for self-generated provenance (or
 * a blank ref — an "external" signal with no real attribution is not proof). The structural gate that
 * makes "score demand on circular evidence" impossible to express.
 */
export function externalDemandEvidence(signal: DemandSignal): ExternalDemandEvidence | null {
  if (!isExternallyAttributed(signal.provenance)) return null;
  if (signal.provenance.attribution.externalRef.trim().length === 0) return null;
  return signal as ExternalDemandEvidence;
}

/** Construct {@link ExternalDemandEvidence} or throw {@link CircularEvidenceError} — the runtime guard. */
export function assertExternalDemandEvidence(signal: DemandSignal): ExternalDemandEvidence {
  const ev = externalDemandEvidence(signal);
  if (!ev) throw new CircularEvidenceError();
  return ev;
}

/**
 * Compile-time proof of the structural guarantee — **validated by `pnpm typecheck`** (the server tsconfig
 * type-checks `src`). It has no runtime effect; it exists so the boundary "a raw signal can never be
 * presented as external demand evidence" is enforced *by the type system*, exactly as #101 requires.
 *
 * The only constructor of {@link ExternalDemandEvidence} is {@link externalDemandEvidence}, which returns
 * `null` for self-generated provenance. The `@ts-expect-error` below asserts a raw {@link DemandSignal} is
 * **not** assignable to the unforgeable brand — so circular evidence can never reach a demand score. If
 * the brand is ever weakened, the directive becomes an unused `@ts-expect-error` and **typecheck FAILS** —
 * the proof breaks the build, not a convention.
 */
export function __assertCircularEvidenceRejected(): void {
  const selfGenerated: DemandSignal = {
    signalClass: "paid",
    provenance: { kind: "self_generated", generator: "advocate-persona" },
    amountCents: 0,
    currency: "usd",
  };
  // @ts-expect-error — a raw DemandSignal is not assignable to the unforgeable ExternalDemandEvidence brand.
  const _forced: ExternalDemandEvidence = selfGenerated;
  void _forced;
}
