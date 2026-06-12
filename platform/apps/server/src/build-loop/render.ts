import type { BuildRunRecord, ReviewAssessment } from "./types.js";

/**
 * Pure render helpers for the Self-Shipping Loop (#172), mirroring `flywheel/render.ts`. They turn a run
 * + a reviewer assessment into the agent task prompts, the structured PR verdict comment, the redacted
 * findings bundle, and the owner escalation summary. No IO; the engine owns the side effects. Anything
 * derived from agent/diff text passes through the injected `redact` before it is persisted or posted.
 */

/** Parse an issue number out of a canonical ref like `github:acme/web#172` (0 when absent). */
export function issueNumberOf(issueRef: string): number {
  const m = issueRef.match(/#(\d+)\s*$/);
  return m ? Number(m[1]) : 0;
}

/** The brief handed to a fresh build session: implement the issue end-to-end and open a PR. */
export function renderBuildTask(run: BuildRunRecord): string {
  return [
    `Self-shipping build for ${run.issueRef}: ${run.issueTitle}.`,
    "",
    "Deliver the change end-to-end on an isolated worktree branch and open a pull request:",
    "- Follow the house rules: approval gates intact, tenant scoping (workspace_id), migrations numbered",
    "  by the issue number, tests for new behavior, and NO secrets in code or logs.",
    "- Keep the diff focused and under the size cap so it can auto-merge within guardrails.",
    "- A reviewer agent will check this PR against the acceptance criteria and the house rubric.",
  ].join("\n");
}

/** The brief handed back to the build session after a FAIL verdict — fix exactly these findings. */
export function renderRevisionTask(run: BuildRunRecord, assessment: ReviewAssessment): string {
  const failed = assessment.checks.filter((c) => !c.ok);
  const lines = failed.map((c) => `- [${c.id}] ${c.detail}`);
  return [
    `Reviewer FAILed PR ${run.prRef ?? "(pending)"} for ${run.issueRef} (round ${run.reviewRounds}).`,
    assessment.summary,
    "",
    "Address every finding below, then push to the same PR branch:",
    ...lines,
  ].join("\n");
}

/** The brief handed to the (separate) reviewer session — judge against the rubric + acceptance criteria. */
export function renderReviewTask(run: BuildRunRecord, acceptanceCriteria: string): string {
  return [
    `Review PR ${run.prRef ?? "(pending)"} for ${run.issueRef}: ${run.issueTitle}.`,
    "",
    "Judge it against BOTH the issue's acceptance criteria and the house rubric (gates intact, tenant",
    "scoping, migrations numbered by issue, tests present, no secrets). Return a PASS/FAIL verdict with",
    "file+line evidence for any failing check.",
    "",
    "Acceptance criteria:",
    acceptanceCriteria || "(none supplied)",
  ].join("\n");
}

/** The structured verdict comment posted on the PR — deterministic order, machine- and human-readable. */
export function renderVerdictComment(run: BuildRunRecord, assessment: ReviewAssessment): string {
  const mark = (ok: boolean) => (ok ? "PASS" : "FAIL");
  const rows = assessment.checks.map((c) => `- **${c.id}**: ${mark(c.ok)} — ${c.detail}`);
  return [
    `## Self-shipping reviewer verdict: ${assessment.verdict.toUpperCase()}`,
    "",
    `Issue: ${run.issueRef} — round ${run.reviewRounds}`,
    assessment.summary,
    "",
    ...rows,
  ].join("\n");
}

/** The redacted structured findings persisted on the review row (never raw secret-bearing text). */
export function renderFindings(assessment: ReviewAssessment, redact: (text: string) => string): string {
  return JSON.stringify({
    verdict: assessment.verdict,
    summary: redact(assessment.summary),
    checks: assessment.checks.map((c) => ({ id: c.id, ok: c.ok, detail: redact(c.detail) })),
  });
}

/** The owner-facing escalation summary (routed through the #13 queue / #148 pager — never an auto-merge). */
export function renderEscalationSummary(run: BuildRunRecord, reason: string): string {
  const map: Record<string, string> = {
    not_agent_ok: "the issue is not labeled agent-ok by a human or the self-QA loop",
    reviewer_fail: "the reviewer did not pass the PR",
    ci_not_green: "CI is not green",
    protected_path: "the PR touches a protected gate/policy/billing/secrets path (always human)",
    diff_too_large: "the diff exceeds the auto-merge size cap",
    max_review_rounds: "the reviewer FAILed after the maximum revise rounds",
    merge_conflict: "a merge-from-main conflict could not be auto-resolved",
    post_merge_regression: "post-merge verification found a regression (auto-revert is PROPOSED, not executed)",
  };
  const why = map[reason] ?? reason;
  return (
    `Self-shipping loop needs you on ${run.issueRef} (${run.issueTitle}). ` +
    `PR ${run.prRef ?? "(none)"} was NOT auto-merged: ${why}. Review and decide.`
  );
}
