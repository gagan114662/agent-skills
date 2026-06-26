/**
 * Domain types for the Venture Factory (#187, ADR-0187): the pipeline that turns an opportunity into a
 * validated, launched venture on autopilot. These are the structured artifacts the pure decision
 * modules (`edge-gate`, `scanner`, `validation`, `bootstrap`) operate on and the IO seams persist via
 * `db/repositories/venture-factory.ts`.
 *
 * The whole factory answers to the premortem (#200). The two load-bearing rules show up directly in
 * these types:
 *   - FM#1 (no edge ⇒ no launch): a {@link VentureCandidate} carries {@link EdgeClaim}s and may not be
 *     bootstrapped until {@link EdgeVerdict.status} is `qualified` — a falsifiable distribution/data/
 *     relationship edge, not zero-cost execution.
 *   - FM#2 (self-reported metrics are fiction): a {@link ValidationScorecard} is built from EXTERNAL
 *     receipts only; everything derived (CAC, score) is labeled UNVERIFIED and never kills/scales alone.
 */

import type { ReversibilityClass } from "../verification/types.js";

// ───────────────────────────── Edge gate (premortem FM#1) ─────────────────────────────

/** The only three legitimate moats: an owned channel, proprietary data, or a privileged relationship. */
export type EdgeKind = "distribution" | "data" | "relationship";

export const EDGE_KINDS: readonly EdgeKind[] = ["distribution", "data", "relationship"];

/** One piece of provenance behind an edge claim. */
export interface EdgeEvidence {
  /** Where the evidence came from — a citation, handle, dataset name, or contract reference. */
  source: string;
  /**
   * True when this is an EXTERNAL receipt / third-party signal (analytics, a signed contract, a
   * delivery webhook) rather than a self-asserted claim. Premortem FM#2: external evidence is real.
   */
  external: boolean;
  /**
   * True when this is an owner-attested asymmetric secret (#100 `owner_secret`) — legitimate
   * non-external provenance (the founder's privileged knowledge), distinct from "we think so".
   */
  ownerAttested: boolean;
  detail: string;
}

/** A falsifiable claim that this venture has a real edge. */
export interface EdgeClaim {
  kind: EdgeKind;
  /** The asserted advantage competitors cannot cheaply replicate. */
  statement: string;
  /**
   * How this edge would be DISPROVEN — must be concrete and non-empty. An edge with no falsification
   * test is not an edge, it is a hope (premortem FM#1). e.g. "if CAC on the owned list exceeds $5 the
   * distribution edge is false".
   */
  falsifiableTest: string;
  evidence: EdgeEvidence[];
}

export type EdgeStatus = "qualified" | "rejected";

/** The verdict of the edge gate — the hard precondition to bootstrapping a venture. */
export interface EdgeVerdict {
  status: EdgeStatus;
  /** The claims that passed (falsifiable + evidenced by an external receipt or owner-attested secret). */
  qualifyingClaims: EdgeClaim[];
  /** Distinct edge classes that qualified (deduped). */
  edgeClasses: EdgeKind[];
  reasons: string[];
}

// ───────────────────────────── Opportunity scanner ─────────────────────────────

/** How a candidate was surfaced. `lens` watches trends/why-now; `scout` watches niches/competition. */
export type CandidateSourceKind = "lens" | "scout" | "owner";

/** The lifecycle of a scanned candidate as it moves through the factory. */
export type CandidateStatus =
  | "scanned" // filed by the scanner with evidence + score
  | "validating" // a smoke test is live within the budget cap
  | "validated" // receipts in, scorecard scored
  | "bootstrap_pending" // promoted; a venture.bootstrap #13 decision is open
  | "launched" // bootstrapped into a live venture
  | "killed"; // edge rejected / validation killed / owner declined

/** The evidence a scanner attaches to a candidate before it is scored. */
export interface CandidateEvidence {
  /** A cited pain/demand intensity (0–10) from the source. */
  painIntensity: number;
  /** Absence of incumbent competition (0–10); a crowded niche scores low. */
  competitionAbsence: number;
  /** When the underlying signal was observed (drives freshness decay). */
  observedAt: Date;
  /** Free-form citations backing the above (forum threads, reviews, changelogs). */
  citations: string[];
}

/** A scored opportunity candidate filed into the portfolio loop. */
export interface VentureCandidate {
  id: string;
  workspaceId: string;
  source: CandidateSourceKind;
  /** The one-line opportunity statement. */
  thesis: string;
  /** A working venture name (run through `namingPrecheck` before any irreversible step). */
  proposedName: string;
  evidence: CandidateEvidence;
  /** 0–100 opportunity score from `scoreCandidate` (multiplicative, like #100). */
  score: number;
  /** The falsifiable edge claims (the FM#1 gate input). */
  edgeClaims: EdgeClaim[];
  status: CandidateStatus;
  createdByMemberId: string | null;
  createdAt: Date;
}

// ───────────────────────────── Validation experiment ─────────────────────────────

/** An EXTERNAL receipt from a live smoke test — the only metric that counts (premortem FM#2). */
export interface ValidationReceipt {
  /** A waitlist signup / preorder (external, e.g. a signed webhook) or ad-spend record. */
  kind: "signup" | "ad_spend";
  /** Cents — the spend for `ad_spend`, 0 for a signup. */
  amountCents: number;
  /** A third-party reference proving this is external (webhook id, Stripe event, analytics id). */
  externalRef: string;
  occurredAt: Date;
}

/** The scorecard built from external validation receipts. Derived fields are UNVERIFIED estimates. */
export interface ValidationScorecard {
  signups: number;
  spentCents: number;
  /** Customer acquisition cost (cents) = spend / signups, or null with zero signups. UNVERIFIED. */
  cacCents: number | null;
  /** 0–100 validation confidence. UNVERIFIED — never kills/scales a venture on its own. */
  score: number;
  /** Always `"UNVERIFIED"` — the estimate label the premortem mandates on derived metrics. */
  estimateLabel: "UNVERIFIED";
}

export type ValidationVerdict = "PROMOTE" | "KILL" | "INCONCLUSIVE";

// ───────────────────────────── Venture bootstrap ─────────────────────────────

/** A single idempotent step in standing up a venture. */
export type BootstrapStepKind =
  | "provision_workspace" // new tenant workspace (#55/#138)
  | "brand_kit" // the mark (#145/#138 brand)
  | "landing_page" // quill/echo landing (#153/#163)
  | "repo_deploy_target" // repo + deploy target if software (#73)
  | "budget_caps" // #71 dollar ceilings
  | "seed_fleet" // the seven-department fleet (#138 seeding)
  | "domain_purchase" // MONEY: register the domain (#13/#170)
  | "ad_spend_start" // MONEY: start paid acquisition (#13/#170)
  | "payment_method"; // MONEY: attach a payment method (#13/#170)

/** Whether a bootstrap step spends money / touches an irreversible boundary. */
export type MoneyClass = "autonomous" | "money";

export interface BootstrapStep {
  kind: BootstrapStepKind;
  /** Stable key making the step a no-op if already done (idempotency, like #138 seeding). */
  idempotencyKey: string;
  /** `money` steps must fit inside the hard budget cap; `autonomous` steps just run. */
  money: MoneyClass;
  /** Estimated spend the factory must reserve before running the step; 0 means no spend is debited. */
  estimatedCostCents: number;
  /** Reversibility class (premortem FM#4); irreversible spend must be cap-reserved before it runs. */
  reversibility: ReversibilityClass;
  summary: string;
}

export interface BootstrapPlan {
  candidateId: string;
  /** Whether the candidate's product is software (adds the repo/deploy-target step). */
  software: boolean;
  steps: BootstrapStep[];
}

/** A bootstrapped, live venture record (idempotent — one per candidate). */
export interface FactoryVenture {
  id: string;
  workspaceId: string;
  candidateId: string;
  /** The #96 venture idea this factory venture became (soft ref), or null until linked. */
  ventureIdeaId: string | null;
  name: string;
  status: "launching" | "launched" | "archived";
  /** Soft ref to the `venture.bootstrap` #13 gate, or null. */
  approvalRequestId: string | null;
  createdAt: Date;
  archivedAt: Date | null;
}

// ───────────────────────────── Persistence records (row-shaped) ─────────────────────────────

/** The persisted candidate row (evidence flattened, plus the edge-gate status). */
export interface CandidateRecord {
  id: string;
  workspaceId: string;
  source: CandidateSourceKind;
  thesis: string;
  proposedName: string;
  painIntensity: number;
  competitionAbsence: number;
  observedAt: Date;
  citations: string[];
  score: number;
  edgeClaims: EdgeClaim[];
  edgeStatus: EdgeStatus | "unevaluated";
  status: CandidateStatus;
  createdByMemberId: string | null;
  createdAt: Date;
}

/** The persisted validation-experiment row. */
export interface ValidationRecord {
  id: string;
  workspaceId: string;
  candidateId: string;
  budgetCapCents: number;
  spentCents: number;
  signups: number;
  cacCents: number | null;
  score: number;
  verdict: ValidationVerdict | null;
  status: "running" | "concluded";
  receipts: ValidationReceipt[];
  createdAt: Date;
  updatedAt: Date;
}
