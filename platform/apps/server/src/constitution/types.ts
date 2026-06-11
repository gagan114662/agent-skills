/**
 * Shared types for the YC Startup Constitution enforcement (#146, ADR-0146). The pure
 * `articles`/`caps`/`love-gate`/`pricing-ladder`/`scorer` modules and the venture-loop IO seam agree
 * on these — mirroring the #96/#117 "pure decision in, side effects out" split.
 */

/** The eight Articles, by roman-numeral id (see {@link ../constitution/articles}). */
export type ArticleId = "I" | "II" | "III" | "IV" | "V" | "VI" | "VII" | "VIII";

/** The venture-loop decision points the constitution scores. */
export type DecisionStage = "SOURCE" | "FUND" | "KILL";

/**
 * Violation severity. `block` is reserved for the ONE check that changes a verdict (the Article I
 * love-gate, which downgrades FUND → ESCALATE); everything else is flag-only.
 */
export type ViolationSeverity = "block" | "high" | "medium" | "low";

/** A venture's go-to-market segment. Optional at intake — absent ⇒ the B2B love-gate never bites. */
export type VentureSegment = "b2b" | "b2c";

/** One recorded constitutional violation — a structured event, never a silent auto-correction. */
export interface ConstitutionViolation {
  article: ArticleId;
  /** Stable machine code (e.g. `love_paradigm_unmet`) — the flywheel fingerprint key. */
  code: string;
  severity: ViolationSeverity;
  stage: DecisionStage;
  /** Human-readable explanation surfaced to the owner. */
  message: string;
}

/** One Article as data — the single source of truth the doc and scorer share. */
export interface Article {
  id: ArticleId;
  title: string;
  principle: string;
  /** The YC source the principle is drawn from. */
  source: string;
  /** A short note on the enforcing system(s). */
  enforcedBy: string;
}

/**
 * The deterministic context a single venture decision is scored against. The venture service gathers
 * the demand-derived booleans/counts behind one seam and hands them here; the scorer is pure.
 */
export interface ConstitutionDecisionContext {
  stage: DecisionStage;
  /** The venture's declared segment, or null when unknown. */
  segment: VentureSegment | null;
  /** Distinct unaffiliated (externally-attributed) paying-intent signals for the idea. */
  unaffiliatedPayingIntentSignals: number;
  /** Whether ANY externally-attributed demand evidence exists (Article V). */
  externalDemandPresent: boolean;
  /** Whether a realized `paid` signal exists (Article VIII). */
  paidSignalPresent: boolean;
}

/** The scorer's output — a (possibly empty) list of violations. */
export interface ConstitutionReport {
  violations: ConstitutionViolation[];
}
