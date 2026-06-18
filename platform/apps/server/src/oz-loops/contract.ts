/**
 * Oz-loops contract (#356, ADR-0356). The shared shapes for the four open-source engineering loops adopted
 * from warpdotdev/oz-for-oss (MIT): issue **triage**, **spec** generation, PR **review**, and PR-**comment**
 * response. Each loop is a PURE decision that turns untrusted ingested DATA into an **advisory proposal** a
 * human reviews — never an action. The `advisory: true` literal is a structural invariant on every output:
 * acting on a proposal (posting a comment, applying a label, closing an issue, merging a PR) can ONLY happen
 * by parking a PENDING `oz_loops.publish_proposal` request in the #13 owner-approval queue. The loop itself
 * touches nothing.
 */

/** The four loops. Mirrors oz-for-oss's `.agents/skills/` (triage-issue / create-*-spec / review-pr / respond). */
export type OzLoopKind = "triage" | "spec" | "review" | "pr_comment";

/** A suggested issue severity from structural triage signals. `unknown` when nothing matched. */
export type TriageSeverity = "low" | "medium" | "high" | "unknown";

/** The suggested disposition of a review — ADVISORY only; never an auto-approve/merge authority. */
export type ReviewVerdict = "looks_good" | "comment" | "needs_changes";

/** Fields every loop output carries. */
export interface OzProposalBase {
  kind: OzLoopKind;
  /** A short, sanitized advisory summary for the owner's #13 card. */
  summary: string;
  /**
   * True iff the ingested content tried to instruct the agent (#200 §6). Recorded so the owner sees the
   * attempt; the loop never follows it.
   */
  injectionFlagged: boolean;
  /**
   * INVARIANT: every loop output is advisory. The loop never closes an issue, merges a PR, or posts a
   * comment. Outward action is gated behind the #13 queue (`oz_loops.publish_proposal`).
   */
  advisory: true;
}

// ─── Triage ─────────────────────────────────────────────────────────────────

export interface TriageInput {
  number: number;
  title: string;
  /** The untrusted issue body (quarantined as DATA before use). */
  body: string;
  /** Labels already on the issue (structural; lowercased for comparison). */
  existingLabels?: string[];
  /** Open issue titles to detect likely duplicates from (structural token overlap only). */
  openIssues?: { number: number; title: string }[];
}

export interface TriageProposal extends OzProposalBase {
  kind: "triage";
  /** Labels suggested from structural signals (the owner applies them — the loop never does). */
  suggestedLabels: string[];
  severity: TriageSeverity;
  /** Numbers of open issues this one likely duplicates (advisory — never auto-closed). */
  likelyDuplicateOf: number[];
  /** Sanitized rationale string for the owner. */
  rationale: string;
}

// ─── Spec ───────────────────────────────────────────────────────────────────

export type SpecKind = "product" | "tech";

export interface SpecInput {
  title: string;
  body: string;
  specKind: SpecKind;
}

export interface SpecProposal extends OzProposalBase {
  kind: "spec";
  specKind: SpecKind;
  /** The DRAFT spec markdown (template + quarantined context). A draft — never posted by the loop. */
  draftMarkdown: string;
  /** The section headings the draft contains. */
  sections: string[];
}

// ─── Review ─────────────────────────────────────────────────────────────────

export type ReviewSeverity = "info" | "warning";

export interface ReviewFinding {
  /** A short rule id, e.g. `debug-artifact`, `todo-marker`, `large-diff`, `missing-tests`. */
  rule: string;
  severity: ReviewSeverity;
  /** Sanitized human-readable message. */
  message: string;
  /** The file the finding is about, if structurally attributable. */
  file?: string;
}

export interface ReviewInput {
  prNumber: number;
  title: string;
  /** The untrusted unified diff (quarantined; only `+/-`/path markers are read structurally). */
  diff: string;
  /** Changed file paths (structural). */
  changedFiles?: string[];
}

export interface ReviewProposal extends OzProposalBase {
  kind: "review";
  findings: ReviewFinding[];
  /** Suggested disposition — ADVISORY. The loop NEVER approves or merges. */
  verdict: ReviewVerdict;
}

// ─── PR comment response ──────────────────────────────────────────────────────

export interface PrCommentInput {
  prNumber: number;
  /** The untrusted reviewer comment (quarantined as DATA). */
  comment: string;
  /** Optional diff/context the reply may reference (quarantined). */
  context?: string;
}

export interface PrCommentProposal extends OzProposalBase {
  kind: "pr_comment";
  /** The DRAFT reply for the owner to review — NEVER auto-posted. */
  draftReply: string;
}

/** Any one of the four advisory loop outputs. */
export type OzProposal = TriageProposal | SpecProposal | ReviewProposal | PrCommentProposal;
