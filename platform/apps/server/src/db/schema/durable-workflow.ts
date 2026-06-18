import {
  pgTable,
  uuid,
  text,
  integer,
  boolean,
  timestamp,
  jsonb,
  index,
  unique,
  check,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { newId } from "../id.js";
import { workspaces } from "./workspaces.js";

/**
 * Durable-workflow persistence (#338, ADR-0338). ONE workspace-scoped table — a durable run is a
 * long-running step's place persisted as a row, not held in an in-process promise, so it survives a
 * process restart and resumes on the next engine tick. Modeled directly on `build_loop_runs` (#172): a
 * status machine + a `unique(workspace_id, idempotency_key)` invariant that makes "one run per logical
 * job" a database fact — the structural guarantee behind "a resumed step never double-applies" (#200 §2).
 *
 * `approval_request_id` is the load-bearing column for the #13 always-gate (#200 §4): an irreversible
 * step cannot leave `waiting_approval` without it. It is a SOFT reference (the approval may be pruned
 * independently); only `workspace_id` carries the #3 tenant boundary (`onDelete: cascade`). The name is
 * intentionally NOT growth_/demand_/venture_/moat_-prefixed so the #155 colocation gate does not class it
 * as a governed metric surface.
 */

export const DURABLE_RUN_STATUSES = [
  "running",
  "suspended",
  "waiting_approval",
  "succeeded",
  "failed",
  "canceled",
] as const;

export const durableRuns = pgTable(
  "durable_runs",
  {
    id: uuid("id").primaryKey().$defaultFn(newId),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    /** The workflow kind (e.g. `github_pages_build_wait`) — groups runs for observability. */
    workflowKey: text("workflow_key").notNull(),
    /** The dedup anchor within the workspace (e.g. `github_pages:owner/repo`). */
    idempotencyKey: text("idempotency_key").notNull(),
    status: text("status", { enum: DURABLE_RUN_STATUSES }).notNull().default("running"),
    /** Attempts of the current step already run (the backoff/exhaustion counter). */
    attempts: integer("attempts").notNull().default(0),
    /** When the next attempt is eligible (set while suspended for backoff), or null when runnable now. */
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }),
    /** Hard wall-clock deadline — once passed the run fails `timeout` (the no-hang guarantee). */
    deadlineAt: timestamp("deadline_at", { withTimezone: true }).notNull(),
    /** The step is irreversible (#200 §4) — cannot leave `waiting_approval` without an approval (#13). */
    requiresApproval: boolean("requires_approval").notNull().default(false),
    /** Soft ref to the #13 approval that authorized an irreversible step, or null. */
    approvalRequestId: uuid("approval_request_id"),
    /** Caller state carried across suspensions (opaque to the engine). */
    state: jsonb("state").notNull().default(sql`'{}'::jsonb`),
    /** The terminal result, persisted on success so a resumed run reads it back rather than re-running. */
    result: jsonb("result"),
    /** A short, redacted failure reason when `status = failed`, or null. */
    error: text("error"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    byWorkspaceStatus: index("durable_runs_workspace_status_idx").on(t.workspaceId, t.status),
    uniqueKey: unique("durable_runs_idempotency_uk").on(t.workspaceId, t.idempotencyKey),
    statusCk: check(
      "durable_runs_status_ck",
      sql`${t.status} IN ('running','suspended','waiting_approval','succeeded','failed','canceled')`,
    ),
  }),
);
