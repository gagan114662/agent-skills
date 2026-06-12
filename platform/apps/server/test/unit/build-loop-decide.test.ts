import { describe, it, expect } from "vitest";
import {
  decideNextIssue,
  decideDispatch,
  decideMergeGuardrails,
  decideReviewOutcome,
  decideRebase,
  decidePostMerge,
  type MergeGuardrailInput,
} from "../../src/build-loop/decide.js";
import type { IssueCandidate } from "../../src/build-loop/types.js";

function cand(over: Partial<IssueCandidate> = {}): IssueCandidate {
  return { issueRef: "github:acme/web#1", title: "t", priority: 0, dependsOn: null, agentOk: true, ...over };
}

describe("decideNextIssue (#172 queue ordering + dependency gating)", () => {
  const empty = new Set<string>();

  it("picks the highest-priority agent-ok candidate, breaking ties by ref", () => {
    const chosen = decideNextIssue({
      candidates: [
        cand({ issueRef: "#a", priority: 1 }),
        cand({ issueRef: "#b", priority: 5 }),
        cand({ issueRef: "#c", priority: 5 }),
      ],
      inFlightRefs: empty,
      mergedRefs: empty,
    });
    expect(chosen?.issueRef).toBe("#b"); // priority 5, ref < "#c"
  });

  it("skips non-agent-ok issues entirely", () => {
    const chosen = decideNextIssue({
      candidates: [cand({ issueRef: "#a", agentOk: false })],
      inFlightRefs: empty,
      mergedRefs: empty,
    });
    expect(chosen).toBeNull();
  });

  it("blocks a candidate whose dependency is not yet merged, and unblocks once it is", () => {
    const candidates = [cand({ issueRef: "#child", dependsOn: "#parent" })];
    expect(decideNextIssue({ candidates, inFlightRefs: empty, mergedRefs: empty })).toBeNull();
    const unblocked = decideNextIssue({
      candidates,
      inFlightRefs: empty,
      mergedRefs: new Set(["#parent"]),
    });
    expect(unblocked?.issueRef).toBe("#child");
  });

  it("never re-picks an in-flight issue", () => {
    const chosen = decideNextIssue({
      candidates: [cand({ issueRef: "#a" })],
      inFlightRefs: new Set(["#a"]),
      mergedRefs: empty,
    });
    expect(chosen).toBeNull();
  });
});

describe("decideDispatch (#172 routing, fail-closed order)", () => {
  const base = { killSwitchEngaged: false, agentOk: true, budgetExhausted: false, concurrencyAvailable: true };
  it("dispatches when everything is clear", () => {
    expect(decideDispatch(base)).toEqual({ action: "dispatch", reason: "dispatch" });
  });
  it("kill switch wins over everything", () => {
    expect(decideDispatch({ ...base, killSwitchEngaged: true }).reason).toBe("kill_switch");
  });
  it("not-agent-ok skips before budget/concurrency", () => {
    expect(decideDispatch({ ...base, agentOk: false }).reason).toBe("not_agent_ok");
  });
  it("budget exhausted skips before concurrency", () => {
    expect(decideDispatch({ ...base, budgetExhausted: true }).reason).toBe("budget_exhausted");
  });
  it("no concurrency headroom skips", () => {
    expect(decideDispatch({ ...base, concurrencyAvailable: false }).reason).toBe("concurrency_cap");
  });
});

describe("decideMergeGuardrails (#172 SAFETY CORE — merge only when ALL hold)", () => {
  const allPass: MergeGuardrailInput = {
    agentOkLabeled: true,
    reviewerPass: true,
    ciGreen: true,
    protectedPathTouched: false,
    diffWithinSizeCap: true,
  };

  it("merges when all five guardrails hold", () => {
    expect(decideMergeGuardrails(allPass)).toEqual({ action: "merge", reason: "guardrails_pass" });
  });

  it("escalates on the FIRST failing guardrail, in the documented order", () => {
    expect(decideMergeGuardrails({ ...allPass, agentOkLabeled: false }).reason).toBe("not_agent_ok");
    expect(decideMergeGuardrails({ ...allPass, reviewerPass: false }).reason).toBe("reviewer_fail");
    expect(decideMergeGuardrails({ ...allPass, ciGreen: false }).reason).toBe("ci_not_green");
    expect(decideMergeGuardrails({ ...allPass, protectedPathTouched: true }).reason).toBe("protected_path");
    expect(decideMergeGuardrails({ ...allPass, diffWithinSizeCap: false }).reason).toBe("diff_too_large");
  });

  it("a protected-path touch ALWAYS escalates — never auto-merges", () => {
    expect(decideMergeGuardrails({ ...allPass, protectedPathTouched: true }).action).toBe("escalate");
  });

  it("agent-ok is a hard precondition even with a perfect review + CI", () => {
    expect(decideMergeGuardrails({ ...allPass, agentOkLabeled: false }).action).toBe("escalate");
  });
});

describe("decideReviewOutcome (#172 revise-then-escalate)", () => {
  it("PASS routes to the merge-guardrail evaluation", () => {
    expect(decideReviewOutcome("pass", 0, 3).action).toBe("merge_eval");
  });
  it("FAIL with rounds remaining revises", () => {
    expect(decideReviewOutcome("fail", 0, 3).action).toBe("revise");
    expect(decideReviewOutcome("fail", 1, 3).action).toBe("revise");
  });
  it("FAIL on the final allowed round escalates instead of looping forever", () => {
    expect(decideReviewOutcome("fail", 2, 3).action).toBe("escalate");
    expect(decideReviewOutcome("fail", 5, 3).action).toBe("escalate");
  });
});

describe("decideRebase / decidePostMerge", () => {
  it("a conflict routes the PR back to its build session", () => {
    expect(decideRebase(true).action).toBe("route_back");
    expect(decideRebase(false).action).toBe("continue");
  });
  it("a post-merge regression PROPOSES a revert (never executes)", () => {
    expect(decidePostMerge(2).action).toBe("propose_revert");
    expect(decidePostMerge(0).action).toBe("clean");
  });
});
