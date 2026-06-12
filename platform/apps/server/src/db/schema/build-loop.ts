import { pgTable, uuid, text, integer, boolean, timestamp, index, unique, check } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { newId } from "../id.js";
import { workspaces } from "./workspaces.js";

/**
 * Self-Shipping Loop persistence (#172, ADR-0172). Two workspace-scoped tables:
 *
 *  - `build_loop_runs` — one durable run per agent-ok issue moving through build → review → merge.
 *    `unique(workspace_id, issue_ref)` makes "one run per issue" a database invariant; carries the
 *    lifecycle status, the PR linkage, the review-round counter (the bound on auto-revise), the merge
 *    ref (the merge history surface), and the escalation reason (the out-of-guardrail audit).
 *  - `build_loop_reviews` — the append-only reviewer-round ledger: every verdict + REDACTED findings,
 *    so the #104 console queue and the audit trail read every loop action from one source of truth.
 *
 * Session ids are **soft references** (no FK): a session row is audit history that may be pruned
 * independently of the run. Only `workspace_id` carries the #3 tenant boundary (`onDelete: cascade`).
 */

export const BUILD_RUN_STATUSES = [
  "queued",
  "building",
  "reviewing",
  "revising",
  "merging",
  "merged",
  "escalated",
  "failed",
] as const;

export const buildLoopRuns = pgTable(
  "build_loop_runs",
  {
    id: uuid("id").primaryKey().$defaultFn(newId),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    /** Canonical issue ref (e.g. `github:acme/web#172`) — the dedup anchor. */
    issueRef: text("issue_ref").notNull(),
    issueTitle: text("issue_title").notNull(),
    /** Higher = sooner in the queue. */
    priority: integer("priority").notNull().default(0),
    /** Another issue ref this run is blocked on until merged (soft ref), or null. */
    dependsOn: text("depends_on"),
    /** Labeled agent-ok by a human or the self-QA loop — the precondition for any auto action. */
    agentOk: boolean("agent_ok").notNull().default(false),
    status: text("status", { enum: BUILD_RUN_STATUSES }).notNull().default("queued"),
    /** Reviewer FAIL→revise rounds run so far (bounded by `maxReviewRounds`). */
    reviewRounds: integer("review_rounds").notNull().default(0),
    /** The dispatched build/revise session (soft reference), or null. */
    buildSessionId: uuid("build_session_id"),
    /** The opened PR's canonical ref, or null before the build agent opens one. */
    prRef: text("pr_ref"),
    /** The PR's head branch (for the rebase-train merge-from-main), or null. */
    prHeadBranch: text("pr_head_branch"),
    /** The merge commit/ref once auto-merged, or null. */
    mergeRef: text("merge_ref"),
    /** Why the run was handed to the owner (the guardrail/round reason), or null. */
    escalationReason: text("escalation_reason"),
    /** Where the build/review/fix agents launch (carried from the issue). Soft references. */
    targetChannelId: uuid("target_channel_id"),
    targetAgentMemberId: uuid("target_agent_member_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    byWorkspaceStatus: index("build_loop_runs_workspace_status_idx").on(t.workspaceId, t.status),
    uniqueIssue: unique("build_loop_runs_issue_uk").on(t.workspaceId, t.issueRef),
    statusCk: check(
      "build_loop_runs_status_ck",
      sql`${t.status} IN ('queued','building','reviewing','revising','merging','merged','escalated','failed')`,
    ),
  }),
);

export const REVIEW_VERDICTS = ["pass", "fail"] as const;

export const buildLoopReviews = pgTable(
  "build_loop_reviews",
  {
    id: uuid("id").primaryKey().$defaultFn(newId),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    runId: uuid("run_id")
      .notNull()
      .references(() => buildLoopRuns.id, { onDelete: "cascade" }),
    round: integer("round").notNull(),
    verdict: text("verdict", { enum: REVIEW_VERDICTS }).notNull(),
    summary: text("summary").notNull().default(""),
    /** The REDACTED structured findings (JSON string) — never raw secret-bearing text (#25). */
    findings: text("findings").notNull().default(""),
    /** The reviewer session (soft reference), or null when the rubric-only reviewer judged it. */
    reviewerSessionId: uuid("reviewer_session_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    byRun: index("build_loop_reviews_run_idx").on(t.runId),
    byWorkspace: index("build_loop_reviews_workspace_idx").on(t.workspaceId),
    verdictCk: check("build_loop_reviews_verdict_ck", sql`${t.verdict} IN ('pass','fail')`),
  }),
);
