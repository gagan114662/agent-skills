import { pgTable, uuid, text, integer, boolean, timestamp, index, unique, check } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { newId } from "../id.js";
import { workspaces } from "./workspaces.js";

/**
 * Self-Healing Flywheel persistence (#117, ADR-0117). Two workspace-scoped tables:
 *
 *  - `failure_fingerprints` — the deduped failure record. `unique(workspace_id, signature)` makes
 *    "same failure twice = one row" a database invariant (not a convention). Carries the redacted
 *    sample bundle (#25), the lifecycle status, the single open-issue anchor (the dedup contract),
 *    and the loop-closure fields (fix linkage + recurrence-after-fix exclusion).
 *  - `flywheel_fix_dispatches` — the durable dispatch ledger: every auto-launch / queued-approval, so
 *    the hard concurrent-fix cap and the #104 console queue both read from one source of truth.
 *
 * Session ids are **soft references** (no FK): a session row is audit history that may be pruned
 * independently, and the fingerprint/dispatch must outlive it. Only `workspace_id` carries the #3
 * tenant boundary (`onDelete: cascade`).
 */

export const FINGERPRINT_STATUSES = ["open", "issued", "fixing", "fixed", "recurred"] as const;
export const FAILURE_CLASSES = [
  "harness_crash",
  "ci_fail",
  "watchdog_revival",
  "slo_breach",
  "venture_error",
  // #146: constitution violations are fingerprinted like any other failure (no DB CHECK on the column).
  "constitution_violation",
  "eval_regression", // #155: an offline agent-skill eval suite dropped below its baseline pass-rate
  "workflow_fail", // #152: a workflow firing's action failed (no DB CHECK on the column)
  "qa_failure", // #171: the self-QA synthetic user found a product-surface bug on the live deployment
  "customer_complaint", // #190: a recurring support complaint crossed the threshold (no DB CHECK on the column)
] as const;

export const failureFingerprints = pgTable(
  "failure_fingerprints",
  {
    id: uuid("id").primaryKey().$defaultFn(newId),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    /** The stable dedup key (`class + normalized message`, hashed). */
    signature: text("signature").notNull(),
    failureClass: text("failure_class", { enum: FAILURE_CLASSES }).notNull(),
    title: text("title").notNull(),
    firstSeenAt: timestamp("first_seen_at", { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
    occurrenceCount: integer("occurrence_count").notNull().default(1),
    /** The REDACTED sample context bundle (JSON string) — render sites read only this (#25). */
    sampleContext: text("sample_context").notNull(),
    status: text("status", { enum: FINGERPRINT_STATUSES }).notNull().default("open"),
    /** Where a fix agent is launched (carried from the originating failure). Soft references. */
    originChannelId: uuid("origin_channel_id"),
    originAgentMemberId: uuid("origin_agent_member_id"),
    /** The single open issue's canonical ref (the dedup anchor), or null before one is filed. */
    issueRef: text("issue_ref"),
    /** `open` | `closed` — the last-synced GitHub state. */
    issueState: text("issue_state"),
    /** Occurrence count at the last issue draft/comment (so we only comment on NEW occurrences). */
    syncedOccurrenceCount: integer("synced_occurrence_count").notNull().default(0),
    /** The dispatched fix session (soft reference), or null. */
    fixSessionId: uuid("fix_session_id"),
    /** The merged fix's ref (PR/commit), set by `markFixed`. */
    fixRef: text("fix_ref"),
    fixedAt: timestamp("fixed_at", { withTimezone: true }),
    /** Recurrence-after-fix removes a class from auto-dispatch (human review required) — #106. */
    excludedFromAutoDispatch: boolean("excluded_from_auto_dispatch").notNull().default(false),
    /** Escalated priority (a recurrence, or a non-retryable class). */
    escalated: boolean("escalated").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    byWorkspaceStatus: index("failure_fingerprints_workspace_status_idx").on(t.workspaceId, t.status),
    uniqueSignature: unique("failure_fingerprints_signature_uk").on(t.workspaceId, t.signature),
    statusCk: check(
      "failure_fingerprints_status_ck",
      sql`${t.status} IN ('open','issued','fixing','fixed','recurred')`,
    ),
  }),
);

export const FIX_DISPATCH_MODES = ["auto", "queued"] as const;
export const FIX_DISPATCH_STATUSES = ["dispatched", "queued", "done", "failed"] as const;

export const flywheelFixDispatches = pgTable(
  "flywheel_fix_dispatches",
  {
    id: uuid("id").primaryKey().$defaultFn(newId),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    fingerprintId: uuid("fingerprint_id")
      .notNull()
      .references(() => failureFingerprints.id, { onDelete: "cascade" }),
    mode: text("mode", { enum: FIX_DISPATCH_MODES }).notNull(),
    status: text("status", { enum: FIX_DISPATCH_STATUSES }).notNull(),
    /** The launched fix session (soft reference), or null for a queued dispatch. */
    sessionId: uuid("session_id"),
    /** The #13 approval request enqueued for a queued dispatch (soft reference), or null. */
    approvalRequestId: uuid("approval_request_id"),
    reason: text("reason").notNull().default(""),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    byWorkspaceStatus: index("flywheel_fix_dispatches_workspace_status_idx").on(t.workspaceId, t.status),
    byFingerprint: index("flywheel_fix_dispatches_fingerprint_idx").on(t.fingerprintId),
    modeCk: check("flywheel_fix_dispatches_mode_ck", sql`${t.mode} IN ('auto','queued')`),
    statusCk: check(
      "flywheel_fix_dispatches_status_ck",
      sql`${t.status} IN ('dispatched','queued','done','failed')`,
    ),
  }),
);
