/**
 * Acceptance test for issue #585 — "Shared memory graph so agents stop duplicating + contradicting each other."
 *
 * The two literal acceptance criteria:
 *   1. "starting a task that overlaps existing work shows the prior result instead of redoing it"
 *   2. "contradictory claims are flagged pre-publish"
 *
 * These drive the public barrel exactly as two cooperating agents would, asserting both behaviors end-to-end.
 */

import { describe, it, expect } from "vitest";
import {
  MemoryGraphService,
  InMemoryGraphStore,
  summarizeConflicts,
  type MemoryGraphCaps,
} from "../../src/memory-graph/index.js";

const WID = "ws-acme";
const CAPS: MemoryGraphCaps = { enabled: true, recallFreshnessMs: 30 * 24 * 60 * 60 * 1000 };

function graph() {
  return new MemoryGraphService({
    store: new InMemoryGraphStore(),
    caps: CAPS,
    now: () => new Date(1_700_000_000_000),
  });
}

describe("#585 acceptance", () => {
  it("AC1: overlapping work shows the prior result instead of redoing it", async () => {
    const g = graph();

    // Agent A researches a keyword and records its finding (write-after-act).
    const recallBeforeA = await g.recall(WID, { subject: "growth loops", kind: "research" });
    expect(recallBeforeA.hasPriorWork).toBe(false); // A has to do the work
    await g.record(WID, {
      kind: "research",
      subject: "growth loops",
      value: "Referral loops outperformed paid by 3x in the test cohort.",
      byAgent: "scout-A",
    });

    // Agent B later picks up a task overlapping the same keyword — read-before-act surfaces A's result.
    const recallForB = await g.recall(WID, { subject: "Growth   Loops", kind: "research" });
    expect(recallForB.hasPriorWork).toBe(true);
    expect(recallForB.priorWork[0]?.value).toContain("Referral loops outperformed paid");
    // B reuses it instead of redoing the research — re-recording dedups to the same node.
    const reRecord = await g.record(WID, {
      kind: "research",
      subject: "growth loops",
      value: "Referral loops outperformed paid by 3x in the test cohort.",
      byAgent: "scout-B",
    });
    expect(reRecord.created).toBe(false); // no duplicate node created
  });

  it("AC2: contradictory claims are flagged pre-publish", async () => {
    const g = graph();

    // Agent A establishes a claim in the shared graph.
    await g.record(WID, {
      kind: "claim",
      subject: "Acme Corp",
      predicate: "pricing_model",
      value: "usage-based",
      byAgent: "analyst-A",
    });

    // Agent B is about to PUBLISH a contradicting claim — the pre-publish check flags it (nothing written).
    const candidate = {
      kind: "claim" as const,
      subject: "Acme Corp",
      predicate: "pricing_model",
      value: "seat-based",
    };
    const conflicts = await g.checkConflicts(WID, candidate);
    expect(conflicts).toHaveLength(1);

    const flag = summarizeConflicts(conflicts);
    expect(flag).not.toBeNull();
    expect(flag).toContain("usage-based");
    expect(flag).toContain("seat-based");

    // A non-contradicting claim about a different attribute publishes clean.
    expect(
      await g.checkConflicts(WID, { kind: "claim", subject: "Acme Corp", predicate: "headcount", value: "200" }),
    ).toHaveLength(0);
  });

  it("AC2: a corrected (superseded) claim no longer triggers a contradiction", async () => {
    const g = graph();
    const first = await g.record(WID, {
      kind: "claim",
      subject: "Acme Corp",
      predicate: "status",
      value: "prospect",
    });
    // The team corrects the record; the old claim is retired and a new one recorded.
    await g.supersede(WID, first.node.id);
    await g.record(WID, { kind: "claim", subject: "Acme Corp", predicate: "status", value: "customer" });

    // Re-stating the new truth does not conflict with the retired claim.
    expect(
      await g.checkConflicts(WID, { kind: "claim", subject: "Acme Corp", predicate: "status", value: "customer" }),
    ).toHaveLength(0);
  });
});
