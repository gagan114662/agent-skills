import { pgTable, text, bigint, integer, timestamp, check } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

/**
 * Durable scheduler state (#559). ONE row per recurring job (planning / venture_memory / verifiers /
 * workflows) — the persisted place of a tick cadence, so it survives a process restart instead of living in
 * an in-process `setInterval`. The table is intentionally GLOBAL (no `workspace_id`): a job's `tickAll`
 * already fans out over every workspace internally, so the cadence itself is a fleet-wide singleton.
 *
 *  - `next_run_at` is the restart-safe cursor: a crash that paused the loop resumes from it (an overdue
 *    cursor fires on the next poll).
 *  - `locked_by` / `locked_until` are the leader lease: a claim is an atomic compare-and-swap UPDATE, so
 *    exactly one instance fires each interval across N replicas (#200 §2 — no double-fire). A crashed
 *    leader's lease expires and another instance reclaims.
 *  - `last_run_at` / `last_status` / `last_error` / `consecutive_failures` are the observability + bounded
 *    backoff inputs.
 *
 * The name is intentionally NOT growth_/demand_/venture_/moat_-prefixed so the #155 colocation gate does
 * not class it as a governed metric surface.
 */

export const SCHEDULER_RUN_STATUSES = ["ok", "error"] as const;

export const schedulerJobs = pgTable(
  "scheduler_jobs",
  {
    /** Stable job identity (e.g. `planning`) — the primary key. */
    jobKey: text("job_key").primaryKey(),
    /** Registered cadence (ms). bigint so a long weekly cadence never overflows int4. */
    intervalMs: bigint("interval_ms", { mode: "number" }).notNull(),
    /** The restart-safe cursor: when the job is next eligible to run. */
    nextRunAt: timestamp("next_run_at", { withTimezone: true }).notNull(),
    /** When the last run completed, or null if it has never run (observability). */
    lastRunAt: timestamp("last_run_at", { withTimezone: true }),
    /** Outcome of the last completed run (`ok` | `error`), or null if never run. */
    lastStatus: text("last_status", { enum: SCHEDULER_RUN_STATUSES }),
    /** A short, redacted reason when `last_status = error`, else null. */
    lastError: text("last_error"),
    /** Consecutive failures — drives bounded backoff; reset to 0 on success. */
    consecutiveFailures: integer("consecutive_failures").notNull().default(0),
    /** The instance id holding the run lease, or null when unleased. */
    lockedBy: text("locked_by"),
    /** When the lease expires (a crashed leader's lock auto-frees), or null. */
    lockedUntil: timestamp("locked_until", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    statusCk: check("scheduler_jobs_status_ck", sql`${t.lastStatus} IN ('ok','error') OR ${t.lastStatus} IS NULL`),
  }),
);
