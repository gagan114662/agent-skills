import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  formatGoalLoopProofReport,
  loadGoalLoopProofJson,
  parseGoalLoopProofCliConfig,
} from "../../src/goal-loop/proof-cli.js";
import type { GoalLoopProof } from "../../src/goal-loop/proof.js";

const goodProof: GoalLoopProof = {
  goal: {
    id: "goal_123",
    statement: "Build the autonomous marketing loop until production proof passes.",
    owner: "workspace",
    createdAt: "2026-06-28T17:30:00.000Z",
  },
  automation: { cadence: "scheduled", triggerReceipt: "run:goal-loop:123", repeatCount: 2 },
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
  budget: { maxTurns: 12, maxTokens: 120000, retryPolicy: "retry_with_backoff" },
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
};

describe("goal-loop proof CLI", () => {
  it("parses --file and -f", () => {
    expect(parseGoalLoopProofCliConfig(["--file", "proof.json"])).toEqual({ file: "proof.json" });
    expect(parseGoalLoopProofCliConfig(["-f=proof.json"])).toEqual({ file: "proof.json" });
  });

  it("loads proof JSON from a file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "goal-loop-proof-"));
    const file = join(dir, "proof.json");
    await writeFile(file, JSON.stringify(goodProof), "utf8");

    await expect(loadGoalLoopProofJson({ file })).resolves.toMatchObject({
      goal: { id: "goal_123" },
    });
  });

  it("formats a passing proof report", () => {
    expect(formatGoalLoopProofReport(goodProof)).toEqual([
      "PASS goal-loop-proof: goal -> action -> verification -> state -> next move proven",
    ]);
  });

  it("formats failing gaps", () => {
    const lines = formatGoalLoopProofReport({
      ...goodProof,
      automation: { cadence: "manual", triggerReceipt: "", repeatCount: 0 },
      state: { persisted: false, store: "state_file", stateRef: "", survivesRestart: false },
    });

    expect(lines[0]).toMatch(/^FAIL goal-loop-proof: \d+ gap\(s\)$/);
    expect(lines.some((line) => line.includes("automated_verification"))).toBe(true);
    expect(lines.some((line) => line.includes("persistent_state"))).toBe(true);
  });

  it("requires a proof JSON body", async () => {
    await expect(loadGoalLoopProofJson({ file: "", readStdin: async () => "" })).rejects.toThrow(
      "goal-loop proof JSON is required",
    );
  });
});
