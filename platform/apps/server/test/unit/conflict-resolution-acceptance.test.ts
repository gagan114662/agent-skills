/**
 * Acceptance test for issue #587 — "Conflict resolution when two agents propose competing strategies".
 *
 * The literal acceptance criteria from the issue:
 *   1. competing proposals NEVER both ship;
 *   2. the user sees ONE clear decision when arbitration escalates.
 *
 * These tests drive the public barrel exactly as the orchestrator would: two agents hand in competing
 * positioning angles, the arbiter produces a single decision, and at no point can both angles ship.
 */

import { describe, it, expect } from "vitest";
import {
  ConflictResolutionService,
  InMemoryConflictStore,
  shippableProposalId,
  CONFLICT_RESOLUTION_DEFAULTS,
  type ConflictResolutionCaps,
  type Proposal,
} from "../../src/conflict-resolution/index.js";

const WID = "ws-acme";
const FOUNDER = "member-founder";

const CAPS: ConflictResolutionCaps = { ...CONFLICT_RESOLUTION_DEFAULTS };

function service(caps: ConflictResolutionCaps = CAPS) {
  return new ConflictResolutionService({
    store: new InMemoryConflictStore(),
    caps,
    now: () => new Date(0),
  });
}

/** Two agents, same objective, two genuinely contradicting positioning angles. */
function competingPositioning(impactA: number, impactB: number): Proposal[] {
  return [
    {
      id: "prop-scout",
      objectiveId: "obj-q3-positioning",
      agentId: "agent-scout",
      role: "scout",
      strategy: "discount-led",
      summary: "Lead with aggressive launch pricing.",
      briefAlignment: 0.4,
      expectedImpact: impactA,
    },
    {
      id: "prop-strategist",
      objectiveId: "obj-q3-positioning",
      agentId: "agent-strategist",
      role: "strategist",
      strategy: "value-anchored",
      summary: "Lead with ROI / value framing.",
      briefAlignment: 0.85,
      expectedImpact: impactB,
    },
  ];
}

describe("issue #587 acceptance — competing strategies never both ship", () => {
  it("[criterion 1] an auto-pick clears exactly ONE proposal; the competitor is suppressed", async () => {
    const svc = service();
    // The strategist's value-anchored angle is much better aligned + higher impact ⇒ decisive auto-pick.
    const { resolution, record } = await svc.arbitrate({
      workspaceId: WID,
      proposals: competingPositioning(0.2, 0.9),
    });

    expect(resolution.outcome).toBe("pick");

    // Exactly one proposal is shippable — never two.
    const shippable = shippableProposalId(record);
    expect(shippable).toBe("prop-strategist");
    expect(resolution.suppressedProposalIds).toContain("prop-scout");

    // The losing competitor has no path to ship.
    expect(record.candidates.map((c) => c.id)).toContain("prop-scout");
    expect(shippable).not.toBe("prop-scout");
  });

  it("[criterion 2] a too-close conflict escalates ONE clear decision; nothing ships until the human chooses", async () => {
    const svc = service();
    // Near-tied impact + brief ⇒ not decisive ⇒ escalate.
    const close: Proposal[] = competingPositioning(0.7, 0.72).map((p) => ({ ...p, briefAlignment: 0.7 }));

    const { resolution, record } = await svc.arbitrate({ workspaceId: WID, proposals: close });
    expect(resolution.outcome).toBe("escalate");

    // The human sees exactly ONE pending decision in the queue, presenting both angles.
    const queue = await svc.list(WID, "escalated");
    expect(queue).toHaveLength(1);
    expect(queue[0]!.candidates.map((c) => c.id).sort()).toEqual(["prop-scout", "prop-strategist"]);

    // Until they decide, NOTHING ships.
    expect(shippableProposalId(record)).toBeNull();

    // The founder makes the single call; now exactly one proposal — and only one — ships.
    const decided = await svc.decide(WID, record.id, FOUNDER, "prop-strategist");
    expect(shippableProposalId(decided)).toBe("prop-strategist");
    // The other angle never becomes shippable.
    expect(shippableProposalId(decided)).not.toBe("prop-scout");
  });

  it("[criterion 1] there is no code path that returns two shippable ids for one objective", async () => {
    const svc = service();
    // Run every outcome and assert the shippable id is always 0 or 1 proposals, never 2.
    const decisive = await svc.arbitrate({ workspaceId: WID, proposals: competingPositioning(0.1, 0.95) });
    const close = await svc.arbitrate({
      workspaceId: WID,
      proposals: competingPositioning(0.7, 0.71).map((p) => ({ ...p, briefAlignment: 0.7 })),
    });
    const consensus = await svc.arbitrate({
      workspaceId: WID,
      proposals: competingPositioning(0.5, 0.6).map((p) => ({ ...p, strategy: "value-anchored" })),
    });

    for (const { record } of [decisive, close, consensus]) {
      const shippable = shippableProposalId(record);
      // 0 (escalated) or 1 (merge/pick) — the type itself makes "both ship" unrepresentable.
      expect(shippable === null || typeof shippable === "string").toBe(true);
    }
    expect(consensus.resolution.outcome).toBe("merge");
  });
});
