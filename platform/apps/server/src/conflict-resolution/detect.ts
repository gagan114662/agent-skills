/**
 * The PURE decision core of issue #587. Given a set of competing {@link Proposal}s for ONE objective and the
 * resolved {@link ConflictResolutionCaps}, it deterministically returns a single {@link ConflictResolution}:
 * merge (consensus), pick (one strategy is decisively strongest), or escalate (too close / too little signal to
 * auto-decide). No IO, no clock, no randomness — the same inputs always yield the same verdict, which is what
 * makes the arbitration auditable and what lets the service test it without a database.
 *
 * Safety posture (mirrors the #670 action-gate classifier — bias toward the human):
 *  - When the top two distinct strategies are within {@link ConflictResolutionCaps.decisiveMargin}, or there is
 *    no scoring signal to separate them, the core ESCALATES rather than guessing. Ambiguity never auto-ships.
 *  - The decision reads only structural fields (strategy key, numeric impact/brief, role token) — never the
 *    free-text summary — so an injected proposal payload cannot steer the outcome (#200 §6).
 */

import type { ConflictResolutionCaps } from "./caps.js";
import { resolveConflictResolutionCaps } from "./caps.js";
import type { ConflictResolution, Proposal, ScoredProposal } from "./types.js";

/** Normalize a strategy/role key for comparison: trimmed + lowercased. */
function norm(key: string): string {
  return key.trim().toLowerCase();
}

/** Clamp a possibly-missing 0..1 signal to [0, 1]; missing/non-finite ⇒ 0 (no signal). */
function clamp01(v: number | null | undefined): number {
  if (v === null || v === undefined || !Number.isFinite(v)) return 0;
  if (v < 0) return 0;
  if (v > 1) return 1;
  return v;
}

/** Role precedence contribution in [0, 1]: highest-authority listed role ⇒ near 1, unlisted ⇒ 0. */
function rolePrecedenceScore(role: string | null | undefined, caps: ConflictResolutionCaps): number {
  if (!role || caps.rolePrecedence.length === 0) return 0;
  const idx = caps.rolePrecedence.indexOf(norm(role));
  if (idx < 0) return 0;
  return (caps.rolePrecedence.length - idx) / caps.rolePrecedence.length;
}

/** Score one proposal as a transparent weighted sum of brief alignment, impact, and role precedence. */
export function scoreProposal(proposal: Proposal, caps: ConflictResolutionCaps): ScoredProposal {
  const brief = caps.weightBrief * clamp01(proposal.briefAlignment);
  const impact = caps.weightImpact * clamp01(proposal.expectedImpact);
  const role = caps.weightRole * rolePrecedenceScore(proposal.role, caps);
  return { proposal, score: brief + impact + role, factors: { brief, impact, role } };
}

/**
 * Deterministic ordering of scored proposals: higher score first; ties broken by higher role precedence, then by
 * proposal id (lexicographic) so the result is stable and reproducible regardless of input order.
 */
function rankProposals(scored: ScoredProposal[], caps: ConflictResolutionCaps): ScoredProposal[] {
  return [...scored].sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    const ra = rolePrecedenceScore(a.proposal.role, caps);
    const rb = rolePrecedenceScore(b.proposal.role, caps);
    if (rb !== ra) return rb - ra;
    return a.proposal.id.localeCompare(b.proposal.id);
  });
}

/** Whether ANY proposal carries a usable brief/impact/role signal; if none do, an auto-pick is not justified. */
function hasAnySignal(scored: ScoredProposal[]): boolean {
  return scored.some((s) => s.score > 0);
}

/**
 * Resolve a single objective's competing proposals into one deterministic decision.
 *
 * @throws if `proposals` is empty, or if the proposals do not all share one `objectiveId` (the caller must
 *         arbitrate one objective at a time — mixing objectives would be a programming error, not a conflict).
 */
export function resolveConflict(
  proposals: Proposal[],
  caps: ConflictResolutionCaps = resolveConflictResolutionCaps(),
): ConflictResolution {
  if (proposals.length === 0) {
    throw new Error("conflict-resolution: cannot resolve an empty proposal set");
  }
  const objectiveId = proposals[0]!.objectiveId;
  if (proposals.some((p) => p.objectiveId !== objectiveId)) {
    throw new Error("conflict-resolution: all proposals must share one objectiveId");
  }

  const scored = proposals.map((p) => scoreProposal(p, caps));
  const ranked = rankProposals(scored, caps);

  // Distinct strategies, in deterministic first-seen order of the ranked list.
  const strategyOrder: string[] = [];
  const bestByStrategy = new Map<string, ScoredProposal>();
  for (const s of ranked) {
    const key = norm(s.proposal.strategy);
    if (!bestByStrategy.has(key)) {
      bestByStrategy.set(key, s);
      strategyOrder.push(key);
    }
  }
  const competingStrategies = strategyOrder.map((k) => bestByStrategy.get(k)!.proposal.strategy);

  // Consensus: every proposal names the same strategy → merge, ship the best representative.
  if (strategyOrder.length === 1) {
    const winner = ranked[0]!;
    return {
      objectiveId,
      outcome: "merge",
      winnerProposalId: winner.proposal.id,
      suppressedProposalIds: [],
      ranked,
      competingStrategies,
      margin: 0,
      reason: `consensus: all ${proposals.length} proposal(s) share strategy "${winner.proposal.strategy}" — merged`,
    };
  }

  // Competing strategies: compare the best proposal of the top strategy vs the best of the next strategy.
  const topStrategyKey = strategyOrder[0]!;
  const top = bestByStrategy.get(topStrategyKey)!;
  const runnerUp = bestByStrategy.get(strategyOrder[1]!)!;
  const margin = top.score - runnerUp.score;

  // Auto-pick only when there is real signal AND the gap clears the decisiveness margin; otherwise escalate.
  if (hasAnySignal(ranked) && margin >= caps.decisiveMargin) {
    const suppressedProposalIds = ranked
      .filter((s) => norm(s.proposal.strategy) !== topStrategyKey)
      .map((s) => s.proposal.id);
    return {
      objectiveId,
      outcome: "pick",
      winnerProposalId: top.proposal.id,
      suppressedProposalIds,
      ranked,
      competingStrategies,
      margin,
      reason:
        `picked "${top.proposal.strategy}" over "${runnerUp.proposal.strategy}" ` +
        `(margin ${margin.toFixed(3)} ≥ ${caps.decisiveMargin}); ${suppressedProposalIds.length} proposal(s) suppressed`,
    };
  }

  return {
    objectiveId,
    outcome: "escalate",
    winnerProposalId: null,
    suppressedProposalIds: [],
    ranked,
    competingStrategies,
    margin,
    reason: !hasAnySignal(ranked)
      ? `escalated: ${competingStrategies.length} competing strategies with no scoring signal to choose between them`
      : `escalated: top two strategies too close (margin ${margin.toFixed(3)} < ${caps.decisiveMargin}) — human decides`,
  };
}
