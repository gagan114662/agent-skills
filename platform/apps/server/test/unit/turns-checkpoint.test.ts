import { describe, it, expect } from "vitest";
import { planRevert, CheckpointError, type TurnRow } from "../../src/turns/checkpoint.js";

/**
 * Pure revert-selection logic (#53). Given a session's ordered checkpoint ledger, decide what a
 * revert restores: the previous checkpoint's worktree sha + conversation cursor, and which turns are
 * discarded. Reverting turn T undoes T and everything after it (restores the state before T).
 */
const turns: TurnRow[] = [
  { id: "t0", idx: 0, headSha: "base000", cursorMessageId: "m_launch" }, // baseline
  { id: "t1", idx: 1, headSha: "sha111", cursorMessageId: "m_a" }, // turn 1 (file A)
  { id: "t2", idx: 2, headSha: "sha222", cursorMessageId: "m_b" }, // turn 2 (file B)
];

describe("planRevert (#53 — revert to before a turn)", () => {
  it("reverting the latest turn restores the previous checkpoint and discards it", () => {
    const plan = planRevert(turns, "t2");
    expect(plan.restoreSha).toBe("sha111"); // before turn 2 = turn 1's snapshot
    expect(plan.truncateAfterMessageId).toBe("m_a"); // keep up to turn 1's messages
    expect(plan.discardedTurnIds).toEqual(["t2"]);
  });

  it("reverting a middle turn discards it and every later turn (contiguous suffix)", () => {
    const plan = planRevert(turns, "t1");
    expect(plan.restoreSha).toBe("base000"); // before turn 1 = the baseline
    expect(plan.truncateAfterMessageId).toBe("m_launch");
    expect(plan.discardedTurnIds).toEqual(["t1", "t2"]);
  });

  it("accepts turns in any order (sorts by idx)", () => {
    const plan = planRevert([turns[2], turns[0], turns[1]], "t2");
    expect(plan.restoreSha).toBe("sha111");
    expect(plan.discardedTurnIds).toEqual(["t2"]);
  });

  it("refuses to revert the baseline or an unknown turn", () => {
    expect(() => planRevert(turns, "t0")).toThrow(CheckpointError);
    expect(() => planRevert(turns, "nope")).toThrow(CheckpointError);
  });

  it("refuses when the restore target has no snapshot", () => {
    const noSnap: TurnRow[] = [
      { id: "t0", idx: 0, headSha: null, cursorMessageId: "m0" },
      { id: "t1", idx: 1, headSha: "sha1", cursorMessageId: "m1" },
    ];
    expect(() => planRevert(noSnap, "t1")).toThrow(CheckpointError);
  });
});
