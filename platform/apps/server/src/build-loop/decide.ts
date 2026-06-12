import { reviewRoundsExhausted } from "./guardrails.js";
import type {
  DispatchDecision,
  IssueCandidate,
  MergeDecision,
  PostMergeDecision,
  RebaseDecision,
  ReviewOutcomeDecision,
  ReviewVerdict,
} from "./types.js";

/**
 * The self-shipping-loop decisions (#172, ADR-0172). **Pure + unit-tested**: the engine does the side
 * effects (launch the build, run the reviewer, apply the merge, page the owner); these functions make
 * the single choice — the #117 `decideDispatch` / #96 `decideVenture` split. The merge-guardrail
 * decision is the safety core: it must fail closed (escalate) on the FIRST failing guardrail.
 */

/** Inputs to choosing the next issue to build (all pure, all from the run/issue rows). */
export interface NextIssueInput {
  /** Candidate issues (agent-ok or not — this function filters). */
  candidates: IssueCandidate[];
  /** Issue refs already in flight (a build/review/merge run) — never picked again. */
  inFlightRefs: ReadonlySet<string>;
  /** Issue refs already merged — used to clear a candidate's `dependsOn`. */
  mergedRefs: ReadonlySet<string>;
}

/**
 * Pick the next issue to dispatch, or null when nothing is eligible. An issue is eligible iff it is
 * `agentOk`, not already in flight, and its `dependsOn` (if any) is merged. Ties break by `priority`
 * (higher first) then `issueRef` (stable) so the choice is deterministic. Capacity is enforced by the
 * caller (the concurrency cap) — this picks the single best candidate.
 */
export function decideNextIssue(input: NextIssueInput): IssueCandidate | null {
  const eligible = input.candidates.filter(
    (c) =>
      c.agentOk &&
      !input.inFlightRefs.has(c.issueRef) &&
      (c.dependsOn === null || input.mergedRefs.has(c.dependsOn)),
  );
  if (eligible.length === 0) return null;
  eligible.sort((a, b) => (b.priority - a.priority) || (a.issueRef < b.issueRef ? -1 : 1));
  return eligible[0] ?? null;
}

/**
 * Whether a queued issue may dispatch a build this tick. The route is gated, in order:
 *   1. kill switch engaged    → skip (the #17 hard stop)
 *   2. not agent-ok           → skip (only human/self-QA-approved issues auto-build)
 *   3. budget exhausted       → skip (the #71 per-issue/tenant dollar ceiling)
 *   4. no concurrency headroom → skip (the hard in-flight build cap)
 *   5. otherwise              → dispatch
 */
export interface DispatchInput {
  killSwitchEngaged: boolean;
  agentOk: boolean;
  budgetExhausted: boolean;
  concurrencyAvailable: boolean;
}
export function decideDispatch(input: DispatchInput): DispatchDecision {
  if (input.killSwitchEngaged) return { action: "skip", reason: "kill_switch" };
  if (!input.agentOk) return { action: "skip", reason: "not_agent_ok" };
  if (input.budgetExhausted) return { action: "skip", reason: "budget_exhausted" };
  if (!input.concurrencyAvailable) return { action: "skip", reason: "concurrency_cap" };
  return { action: "dispatch", reason: "dispatch" };
}

/**
 * The auto-merge guardrail evaluation — the heart of #172 criterion 3. Merge ONLY when ALL hold;
 * anything else escalates to the owner (never a silent merge, never a destructive override). Checked in
 * a fixed order so the escalation reason names the FIRST violated guardrail:
 *   1. issue not agent-ok      → escalate `not_agent_ok`
 *   2. reviewer did not PASS    → escalate `reviewer_fail`
 *   3. CI not green             → escalate `ci_not_green`
 *   4. a protected path touched → escalate `protected_path`   (gates/policy/billing/secrets: always human)
 *   5. diff over the size cap   → escalate `diff_too_large`
 *   6. all guardrails hold      → merge `guardrails_pass`
 */
export interface MergeGuardrailInput {
  agentOkLabeled: boolean;
  reviewerPass: boolean;
  ciGreen: boolean;
  protectedPathTouched: boolean;
  diffWithinSizeCap: boolean;
}
export function decideMergeGuardrails(input: MergeGuardrailInput): MergeDecision {
  if (!input.agentOkLabeled) return { action: "escalate", reason: "not_agent_ok" };
  if (!input.reviewerPass) return { action: "escalate", reason: "reviewer_fail" };
  if (!input.ciGreen) return { action: "escalate", reason: "ci_not_green" };
  if (input.protectedPathTouched) return { action: "escalate", reason: "protected_path" };
  if (!input.diffWithinSizeCap) return { action: "escalate", reason: "diff_too_large" };
  return { action: "merge", reason: "guardrails_pass" };
}

/**
 * What to do after a reviewer round. PASS → evaluate the merge guardrails. FAIL with rounds remaining →
 * revise (hand the findings back to the build agent). FAIL with rounds exhausted → escalate. `reviewRounds`
 * is the count BEFORE this round, so the guard compares `reviewRounds + 1` against the cap.
 */
export function decideReviewOutcome(
  verdict: ReviewVerdict,
  reviewRounds: number,
  maxReviewRounds: number,
): ReviewOutcomeDecision {
  if (verdict === "pass") return { action: "merge_eval", reason: "reviewer_pass" };
  if (reviewRoundsExhausted(reviewRounds + 1, maxReviewRounds)) {
    return { action: "escalate", reason: "max_review_rounds" };
  }
  return { action: "revise", reason: "reviewer_fail_retry" };
}

/**
 * A rebase-train merge-from-main result. A conflict routes the PR back to its build session to resolve
 * (status `revising`); a clean update continues (the PR stays open, re-runs CI).
 */
export function decideRebase(conflicted: boolean): RebaseDecision {
  return conflicted
    ? { action: "route_back", reason: "merge_conflict" }
    : { action: "continue", reason: "fast_forward" };
}

/**
 * The post-merge verify outcome. A regression PROPOSES a revert to the owner (criterion 5: auto-revert is
 * never executed); a clean verify is terminal-clean.
 */
export function decidePostMerge(regressions: number): PostMergeDecision {
  return regressions > 0
    ? { action: "propose_revert", reason: "post_merge_regression" }
    : { action: "clean", reason: "post_merge_clean" };
}
