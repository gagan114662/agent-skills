/**
 * Shared types for the Self-Shipping Loop (#172, ADR-0172) — the platform-ification of the human-run
 * loop (file issue → dispatch build seat → review → CI → merge → rebase-train → deploy → verify). The
 * pure `guardrails`/`rubric`/`caps`/`decide`/`render` modules and the IO `engine` agree on these,
 * mirroring the #117 flywheel / #115 planning split (pure decision in, side effects out).
 */

/** Where one self-shipping run sits in the build→review→merge lifecycle. */
export const BUILD_RUN_STATUSES = [
  "queued", // an agent-ok issue picked up, awaiting a build seat (concurrency-capped)
  "building", // a cloud build session is in flight; we watch for it to open a PR
  "reviewing", // the PR is open; the reviewer session judges it against the rubric
  "revising", // the reviewer FAILed; the build session is fixing the findings (round-bounded)
  "merging", // guardrails passed; the merge is being applied
  "merged", // terminal success
  "escalated", // outside guardrails (or max review rounds) → handed to the owner, never merged
  "failed", // terminal failure (no PR after the build, a hard error)
] as const;
export type BuildRunStatus = (typeof BUILD_RUN_STATUSES)[number];

/** A reviewer's binary verdict on a PR. */
export const REVIEW_VERDICTS = ["pass", "fail"] as const;
export type ReviewVerdict = (typeof REVIEW_VERDICTS)[number];

/**
 * One repo issue the loop may pick up. `agentOk` is the human (or self-QA) gate: an issue that is not
 * `agentOk` is never auto-dispatched (it can be recorded for visibility but the loop skips it). `priority`
 * orders the queue (higher first); `dependsOn` is another issue's ref this one must wait for (a merged
 * dependency, or null). The fields are exactly what `recordIssue`/`IssueSource` supply.
 */
export interface IssueCandidate {
  /** Canonical issue ref, e.g. `github:acme/web#172`. The dedup anchor for a run. */
  issueRef: string;
  title: string;
  /** Higher = sooner. Defaults to 0 (FIFO within a priority band, by ref). */
  priority: number;
  /** Another issue ref this one is blocked on until it is merged, or null. */
  dependsOn: string | null;
  /** Labeled `agent-ok` by a human or the self-QA loop — the precondition for any auto action. */
  agentOk: boolean;
}

/** A durable self-shipping run (one row in `build_loop_runs`). */
export interface BuildRunRecord {
  id: string;
  workspaceId: string;
  /** The canonical issue ref (the dedup anchor — UNIQUE per workspace). */
  issueRef: string;
  issueTitle: string;
  priority: number;
  dependsOn: string | null;
  agentOk: boolean;
  status: BuildRunStatus;
  /** How many reviewer rounds have run (each FAIL → a revise round, capped by `maxReviewRounds`). */
  reviewRounds: number;
  /** The dispatched build session (soft reference), or null. */
  buildSessionId: string | null;
  /** The opened PR's canonical ref, or null before the build agent opens one. */
  prRef: string | null;
  /** The PR's head branch (for the rebase-train merge-from-main), or null. */
  prHeadBranch: string | null;
  /** The merge commit/ref once merged, or null. */
  mergeRef: string | null;
  /** Why the run was handed to the owner (the guardrail/round reason), or null. */
  escalationReason: string | null;
  /** Where the build/review/fix agents are launched (carried from the issue), or null. */
  targetChannelId: string | null;
  targetAgentMemberId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

/** One reviewer round (one row in `build_loop_reviews`) — the durable, auditable review ledger. */
export interface BuildReviewRecord {
  id: string;
  workspaceId: string;
  runId: string;
  round: number;
  verdict: ReviewVerdict;
  /** Human-readable one-line summary of the verdict. */
  summary: string;
  /** The REDACTED structured findings (JSON string) — never raw secret-bearing text (#25). */
  findings: string;
  /** The reviewer session (soft reference), or null when the rubric-only reviewer judged it. */
  reviewerSessionId: string | null;
  createdAt: Date;
}

// ---- review rubric (pure) ----------------------------------------------------------------------

/** One house-rubric check the reviewer evaluated against the PR diff. */
export interface RubricCheck {
  /** Stable id (a low-cardinality vocabulary; surfaced in the verdict comment). */
  id: RubricCheckId;
  ok: boolean;
  /** Short evidence string (file+line where possible). Redacted before persistence. */
  detail: string;
}

/** The fixed house-rubric vocabulary (gates intact, tenant scoping, migrations, tests, no secrets). */
export const RUBRIC_CHECK_IDS = [
  "tests_present", // the diff includes test coverage
  "migrations_numbered", // every migration file is numbered by the issue number
  "tenant_scoping", // a new table/query is workspace-scoped
  "no_secrets", // no added line leaks a secret
  "gates_intact", // approval/policy/billing/secrets paths are untouched (else human review)
] as const;
export type RubricCheckId = (typeof RUBRIC_CHECK_IDS)[number];

/** The reviewer's full assessment: a verdict plus the per-check evidence. */
export interface ReviewAssessment {
  verdict: ReviewVerdict;
  summary: string;
  checks: RubricCheck[];
}

// ---- decisions (pure) --------------------------------------------------------------------------

/** Whether to dispatch a build for a queued issue this tick. */
export type DispatchAction = "dispatch" | "skip";
export interface DispatchDecision {
  action: DispatchAction;
  reason: string;
}

/** The single auto-merge-guardrail decision: merge within guardrails, or escalate to the owner. */
export type MergeAction = "merge" | "escalate";
export interface MergeDecision {
  action: MergeAction;
  reason: string;
}

/** What to do after a reviewer round: evaluate the merge guardrails, revise, or escalate. */
export type ReviewOutcomeAction = "merge_eval" | "revise" | "escalate";
export interface ReviewOutcomeDecision {
  action: ReviewOutcomeAction;
  reason: string;
}

/** What a rebase-train merge-from-main attempt resolves to. */
export type RebaseAction = "continue" | "route_back";
export interface RebaseDecision {
  action: RebaseAction;
  reason: string;
}

/** The post-merge verify outcome. Auto-revert is only ever PROPOSED to the owner, never executed. */
export type PostMergeAction = "clean" | "propose_revert";
export interface PostMergeDecision {
  action: PostMergeAction;
  reason: string;
}
