/**
 * Shared types for the agent conflict-resolution module (issue #587).
 *
 * The problem: when two or more agents independently propose competing strategies toward the SAME objective
 * (e.g. two different positioning angles), there is no arbiter — so whichever proposal ships last silently wins.
 * This module gives the orchestrator a deterministic arbitration step that detects the conflict and produces ONE
 * decision: merge (the agents actually agree), pick the strongest by a transparent score, or escalate a single
 * choice to the human approval queue. The structural guarantee the acceptance criterion rests on is that at most
 * ONE proposal is ever cleared to ship per objective (see {@link shippableProposalId}).
 *
 * Everything here is plain data. The pure decision core in `detect.ts` reads only these structural fields — never
 * untrusted prose — so a poisoned proposal summary can never flip the verdict (#200 §6 trust boundary).
 */

/**
 * One agent's proposed strategy/action toward a shared objective. Proposals that carry the SAME (normalized)
 * {@link strategy} key are treated as agreement; proposals with different keys on the same objective compete.
 */
export interface Proposal {
  /** Stable id for this proposal (unique within the objective). */
  id: string;
  /** Groups competing proposals — all proposals arbitrated together share one objective. */
  objectiveId: string;
  /** The agent (or member) that authored the proposal. */
  agentId: string;
  /**
   * The canonical approach key. Two proposals AGREE iff this matches (case/space-insensitively); two distinct
   * keys on one objective are a conflict. Keep this a short label ("aggressive-discount", "founder-led"), not
   * free prose — it is the contradiction signal, so it must be a stable token.
   */
  strategy: string;
  /** The agent's role, used for deterministic role-precedence weighting/tiebreak. */
  role?: string | null;
  /** A short human summary shown in the escalation queue. Never read by the decision core. */
  summary?: string | null;
  /** Expected impact, higher = better. Any real number; 0..1 recommended. Missing ⇒ treated as no signal. */
  expectedImpact?: number | null;
  /** Alignment with the campaign brief, 0..1, higher = better. Missing ⇒ treated as no signal. */
  briefAlignment?: number | null;
}

/** The three deterministic ways a conflict is resolved. */
export type ResolutionOutcome =
  /** All proposals share one strategy — they agree; the merged strategy ships. */
  | "merge"
  /** Distinct strategies, one decisively stronger by score — it is auto-picked, the rest suppressed. */
  | "pick"
  /** Distinct strategies, too close (or too little signal) to auto-decide — one choice is escalated to a human. */
  | "escalate";

/** A proposal with its transparent, additive score and the factors that produced it. */
export interface ScoredProposal {
  proposal: Proposal;
  /** Weighted sum of the factor contributions below (higher ranks first). */
  score: number;
  factors: {
    /** Contribution from campaign-brief alignment. */
    brief: number;
    /** Contribution from expected impact. */
    impact: number;
    /** Contribution from role precedence. */
    role: number;
  };
}

/** The arbitration verdict for one objective — exactly one decision, fully explained. */
export interface ConflictResolution {
  objectiveId: string;
  outcome: ResolutionOutcome;
  /**
   * The single proposal cleared to ship for `merge` / `pick`; `null` for `escalate` (nothing ships until a human
   * decides). This is the heart of the "competing proposals never both ship" guarantee.
   */
  winnerProposalId: string | null;
  /** Proposals explicitly NOT cleared to ship (competing strategies that lost an auto-pick). */
  suppressedProposalIds: string[];
  /** Every proposal scored, ranked best-first (deterministic). */
  ranked: ScoredProposal[];
  /** Distinct strategy keys detected on this objective; length 1 ⇒ consensus. */
  competingStrategies: string[];
  /** Score gap between the best strategy and the next-best DISTINCT strategy (0 when only one strategy). */
  margin: number;
  /** Human-readable explanation of the decision. */
  reason: string;
}
