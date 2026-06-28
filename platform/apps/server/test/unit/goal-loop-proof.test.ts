import { describe, expect, it } from "vitest";
import { verifyGoalLoopProof, type GoalLoopProof } from "../../src/goal-loop/proof.js";

function proof(over: Partial<GoalLoopProof> = {}): GoalLoopProof {
  return {
    goal: {
      id: "goal_123",
      statement: "Build the autonomous marketing loop until production proof passes.",
      owner: "workspace",
      createdAt: "2026-06-28T17:30:00.000Z",
    },
    automation: {
      cadence: "event_driven",
      triggerReceipt: "run:goal-loop:123",
      repeatCount: 3,
    },
    verification: {
      automated: true,
      command: "pnpm -C platform --filter @reload/server goal-loop:proof -- --file proof.json",
      lastRunAt: "2026-06-28T17:31:00.000Z",
      lastResult: "pass",
      receipt: "artifact:goal-loop-proof-123",
    },
    state: {
      persisted: true,
      store: "github_issue",
      stateRef: "issue:403#goal-loop-state",
      survivesRestart: true,
    },
    budget: {
      maxTurns: 12,
      maxTokens: 120000,
      retryPolicy: "retry_with_backoff",
    },
    seniorTools: {
      rootCauseLogged: true,
      blockersNamed: true,
      escalationPath: "GitHub issue comment with owner-visible blocker and next move",
    },
    nextMove: {
      decision: "continue",
      reason: "Verifier passed for the loop primitive; continue to provider-backed customer proof.",
      nextGoalId: "goal_124",
    },
    ...over,
  };
}

describe("goal-loop proof gate", () => {
  it("passes a closed-loop proof with automation, verifier, state, budget, and next move", () => {
    expect(verifyGoalLoopProof(proof())).toEqual({ proven: true, gaps: [] });
  });

  it("rejects manual prompting as the loop", () => {
    const result = verifyGoalLoopProof(
      proof({ automation: { cadence: "manual", triggerReceipt: "run:manual", repeatCount: 1 } }),
    );

    expect(result.proven).toBe(false);
    expect(result.gaps.map((gap) => gap.requirement)).toContain("automated_verification");
  });

  it("rejects state that only lives inside an agent turn", () => {
    const result = verifyGoalLoopProof(
      proof({
        state: {
          persisted: false,
          store: "state_file",
          stateRef: "state:tmp",
          survivesRestart: false,
        },
      }),
    );

    expect(result.proven).toBe(false);
    expect(result.gaps.map((gap) => gap.requirement)).toContain("persistent_state");
  });

  it("rejects missing verifier receipts and unbounded retry", () => {
    const result = verifyGoalLoopProof(
      proof({
        verification: {
          automated: false,
          command: "",
          lastRunAt: "",
          lastResult: "fail",
          receipt: "",
        },
        budget: { maxTurns: 5, maxTokens: 5000, retryPolicy: "retry_until_pass" },
      }),
    );

    expect(result.proven).toBe(false);
    expect(result.gaps.map((gap) => gap.requirement)).toContain("automated_verification");
    expect(result.gaps.map((gap) => gap.requirement)).toContain("bounded_loop");
  });
});
