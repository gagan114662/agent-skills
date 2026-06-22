/**
 * Unit tests for the PURE decision core of issue #587 (`resolveConflict`). Covers the three deterministic
 * outcomes — merge (consensus), pick (one strategy decisively strongest), escalate (too close / no signal) —
 * plus determinism and input validation.
 */

import { describe, it, expect } from "vitest";
import { resolveConflict, scoreProposal } from "../../src/conflict-resolution/detect.js";
import {
  CONFLICT_RESOLUTION_DEFAULTS,
  type ConflictResolutionCaps,
} from "../../src/conflict-resolution/caps.js";
import type { Proposal } from "../../src/conflict-resolution/types.js";

const CAPS: ConflictResolutionCaps = { ...CONFLICT_RESOLUTION_DEFAULTS };

function p(over: Partial<Proposal> & Pick<Proposal, "id" | "strategy">): Proposal {
  return {
    objectiveId: "obj-launch-positioning",
    agentId: `agent-${over.id}`,
    ...over,
  };
}

describe("resolveConflict — pure arbitration core (#587)", () => {
  it("MERGE: when every proposal names the same strategy, it merges and ships one representative", () => {
    const proposals = [
      p({ id: "a", strategy: "founder-led", briefAlignment: 0.8, expectedImpact: 0.5 }),
      p({ id: "b", strategy: "Founder-Led", briefAlignment: 0.6, expectedImpact: 0.4 }), // same key, different case
      p({ id: "c", strategy: " founder-led ", briefAlignment: 0.7, expectedImpact: 0.9 }), // whitespace variant
    ];
    const r = resolveConflict(proposals, CAPS);
    expect(r.outcome).toBe("merge");
    expect(r.competingStrategies).toHaveLength(1);
    expect(r.winnerProposalId).not.toBeNull();
    // No competing strategy ⇒ nothing is suppressed.
    expect(r.suppressedProposalIds).toEqual([]);
  });

  it("PICK: distinct strategies with a decisive brief/impact gap auto-picks the strongest, suppresses the rest", () => {
    const proposals = [
      // Strongly brief-aligned, high impact.
      p({ id: "winner", strategy: "value-anchored", briefAlignment: 0.95, expectedImpact: 0.9 }),
      // A genuinely competing angle, much weaker.
      p({ id: "loser", strategy: "discount-led", briefAlignment: 0.2, expectedImpact: 0.2 }),
    ];
    const r = resolveConflict(proposals, CAPS);
    expect(r.outcome).toBe("pick");
    expect(r.winnerProposalId).toBe("winner");
    expect(r.suppressedProposalIds).toEqual(["loser"]);
    expect(r.margin).toBeGreaterThanOrEqual(CAPS.decisiveMargin);
  });

  it("PICK suppresses ALL proposals not sharing the winning strategy (not just the runner-up)", () => {
    const proposals = [
      p({ id: "w1", strategy: "value-anchored", briefAlignment: 0.95, expectedImpact: 0.9 }),
      p({ id: "w2", strategy: "value-anchored", briefAlignment: 0.9, expectedImpact: 0.8 }), // agrees with winner
      p({ id: "l1", strategy: "discount-led", briefAlignment: 0.1, expectedImpact: 0.1 }),
      p({ id: "l2", strategy: "fear-led", briefAlignment: 0.15, expectedImpact: 0.05 }),
    ];
    const r = resolveConflict(proposals, CAPS);
    expect(r.outcome).toBe("pick");
    // The winner and its agreeing sibling are NOT suppressed; the two competing strategies are.
    expect(new Set(r.suppressedProposalIds)).toEqual(new Set(["l1", "l2"]));
    expect(r.suppressedProposalIds).not.toContain("w2");
  });

  it("ESCALATE: two distinct strategies that are too close to call go to a human", () => {
    const proposals = [
      p({ id: "x", strategy: "founder-led", briefAlignment: 0.7, expectedImpact: 0.6 }),
      p({ id: "y", strategy: "product-led", briefAlignment: 0.69, expectedImpact: 0.61 }),
    ];
    const r = resolveConflict(proposals, CAPS);
    expect(r.outcome).toBe("escalate");
    expect(r.winnerProposalId).toBeNull();
    expect(r.margin).toBeLessThan(CAPS.decisiveMargin);
    // Escalation auto-suppresses nothing — the human chooses.
    expect(r.suppressedProposalIds).toEqual([]);
  });

  it("ESCALATE: competing strategies with NO scoring signal cannot be auto-decided", () => {
    const proposals = [
      p({ id: "x", strategy: "founder-led" }), // no brief / impact / role
      p({ id: "y", strategy: "product-led" }),
    ];
    const r = resolveConflict(proposals, CAPS);
    expect(r.outcome).toBe("escalate");
    expect(r.winnerProposalId).toBeNull();
    expect(r.reason).toMatch(/no scoring signal/i);
  });

  it("role precedence breaks an otherwise-even decision in favor of the higher-authority role", () => {
    const caps: ConflictResolutionCaps = {
      ...CAPS,
      rolePrecedence: ["strategist", "writer"],
      // Lean entirely on role so the tiebreak is observable.
      weightBrief: 0,
      weightImpact: 0,
      weightRole: 1,
      decisiveMargin: 0.1,
    };
    const proposals = [
      p({ id: "writer-pick", strategy: "playful", role: "writer", briefAlignment: 0.9 }),
      p({ id: "strategist-pick", strategy: "serious", role: "strategist", briefAlignment: 0.9 }),
    ];
    const r = resolveConflict(proposals, caps);
    expect(r.outcome).toBe("pick");
    expect(r.winnerProposalId).toBe("strategist-pick");
  });

  it("is deterministic and order-independent", () => {
    const proposals = [
      p({ id: "a", strategy: "value-anchored", briefAlignment: 0.95, expectedImpact: 0.9 }),
      p({ id: "b", strategy: "discount-led", briefAlignment: 0.2, expectedImpact: 0.2 }),
      p({ id: "c", strategy: "fear-led", briefAlignment: 0.3, expectedImpact: 0.1 }),
    ];
    const forward = resolveConflict(proposals, CAPS);
    const reversed = resolveConflict([...proposals].reverse(), CAPS);
    expect(reversed.outcome).toBe(forward.outcome);
    expect(reversed.winnerProposalId).toBe(forward.winnerProposalId);
    expect(new Set(reversed.suppressedProposalIds)).toEqual(new Set(forward.suppressedProposalIds));
  });

  it("scoreProposal is a transparent additive sum of the three factors", () => {
    const scored = scoreProposal(
      p({ id: "a", strategy: "x", briefAlignment: 1, expectedImpact: 1 }),
      { ...CAPS, rolePrecedence: [], weightBrief: 0.5, weightImpact: 0.35, weightRole: 0.15 },
    );
    expect(scored.factors.brief).toBeCloseTo(0.5);
    expect(scored.factors.impact).toBeCloseTo(0.35);
    expect(scored.factors.role).toBeCloseTo(0);
    expect(scored.score).toBeCloseTo(scored.factors.brief + scored.factors.impact + scored.factors.role);
  });

  it("rejects an empty set and a mixed-objective set", () => {
    expect(() => resolveConflict([], CAPS)).toThrow(/empty/i);
    expect(() =>
      resolveConflict(
        [
          p({ id: "a", strategy: "x" }),
          { ...p({ id: "b", strategy: "y" }), objectiveId: "other-objective" },
        ],
        CAPS,
      ),
    ).toThrow(/objectiveId/);
  });
});
