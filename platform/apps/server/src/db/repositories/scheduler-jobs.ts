import { and, eq, lte, or, isNull } from "drizzle-orm";
import { db } from "../index.js";
import { schedulerJobs } from "../schema/index.js";
import type { SchedulerJobState, SchedulerStore, SchedulerRunStatus } from "../../scheduler/types.js";

/**
 * Postgres-backed {@link SchedulerStore} (#559). The whole single-leader guarantee lives in `claimDue`: a
 * single conditional `UPDATE ... WHERE due AND (unleased OR lease-expired) RETURNING *`. Postgres row-locks
 * the matched row, so when two replicas race, the loser re-evaluates the WHERE against the just-updated row
 * (EvalPlanQual), sees the fresh lease, matches nothing, and returns zero rows — exactly one claim wins.
 *
 * `ensureJob` is idempotent (INSERT ... ON CONFLICT DO UPDATE the cadence only) and never resets the cursor,
 * so a redeploy/restart RESUMES from the persisted `next_run_at` rather than skipping a beat. Times cross
 * the seam as epoch ms so the pure scheduler core never touches `Date`.
 */
export const dbSchedulerStore: SchedulerStore = {
  async ensureJob(input: {
    jobKey: string;
    intervalMs: number;
    nowMs: number;
  }): Promise<SchedulerJobState> {
    const now = new Date(input.nowMs);
    await db
      .insert(schedulerJobs)
      .values({
        jobKey: input.jobKey,
        intervalMs: input.intervalMs,
        // First cursor is one interval out — a fresh job fires after one interval, like setInterval.
        nextRunAt: new Date(input.nowMs + Math.max(0, input.intervalMs)),
        createdAt: now,
        updatedAt: now,
      })
      // Existing row: refresh the cadence but KEEP next_run_at (restart-safe cursor) and the lease/counters.
      .onConflictDoUpdate({
        target: schedulerJobs.jobKey,
        set: { intervalMs: input.intervalMs, updatedAt: now },
      });
    const row = await this.get(input.jobKey);
    if (!row) throw new Error(`scheduler_jobs ensureJob: row missing after upsert for ${input.jobKey}`);
    return row;
  },

  async claimDue(input: {
    jobKey: string;
    nowMs: number;
    leaseMs: number;
    instanceId: string;
  }): Promise<SchedulerJobState | null> {
    const now = new Date(input.nowMs);
    const [row] = await db
      .update(schedulerJobs)
      .set({
        lockedBy: input.instanceId,
        lockedUntil: new Date(input.nowMs + input.leaseMs),
        updatedAt: now,
      })
      .where(
        and(
          eq(schedulerJobs.jobKey, input.jobKey),
          lte(schedulerJobs.nextRunAt, now),
          or(isNull(schedulerJobs.lockedUntil), lte(schedulerJobs.lockedUntil, now)),
        ),
      )
      .returning();
    return row ? toState(row) : null;
  },

  async complete(input: {
    jobKey: string;
    instanceId: string;
    lastRunAtMs: number;
    nextRunAtMs: number;
    status: SchedulerRunStatus;
    error: string | null;
    consecutiveFailures: number;
  }): Promise<void> {
    await db
      .update(schedulerJobs)
      .set({
        lastRunAt: new Date(input.lastRunAtMs),
        nextRunAt: new Date(input.nextRunAtMs),
        lastStatus: input.status,
        lastError: input.error,
        consecutiveFailures: input.consecutiveFailures,
        lockedBy: null,
        lockedUntil: null,
        updatedAt: new Date(input.lastRunAtMs),
      })
      // Only the lease holder may write the cursor (a reclaimed lease means someone else owns it now).
      .where(and(eq(schedulerJobs.jobKey, input.jobKey), eq(schedulerJobs.lockedBy, input.instanceId)));
  },

  async get(jobKey: string): Promise<SchedulerJobState | null> {
    const rows = await db.select().from(schedulerJobs).where(eq(schedulerJobs.jobKey, jobKey)).limit(1);
    return rows[0] ? toState(rows[0]) : null;
  },

  async list(): Promise<SchedulerJobState[]> {
    const rows = await db.select().from(schedulerJobs).orderBy(schedulerJobs.jobKey);
    return rows.map(toState);
  },
};

type Row = typeof schedulerJobs.$inferSelect;

function toState(row: Row): SchedulerJobState {
  return {
    jobKey: row.jobKey,
    intervalMs: Number(row.intervalMs),
    nextRunAtMs: row.nextRunAt.getTime(),
    lastRunAtMs: row.lastRunAt ? row.lastRunAt.getTime() : null,
    lastStatus: (row.lastStatus as SchedulerRunStatus | null) ?? null,
    lastError: row.lastError ?? null,
    consecutiveFailures: row.consecutiveFailures,
    lockedBy: row.lockedBy ?? null,
    lockedUntilMs: row.lockedUntil ? row.lockedUntil.getTime() : null,
    updatedAtMs: row.updatedAt.getTime(),
  };
}
