import { and, eq, inArray, isNull, lte, or } from "drizzle-orm";
import { db } from "../index.js";
import { durableRuns } from "../schema/index.js";
import type {
  DurableRunStore,
  NewDurableRun,
} from "../../durable-workflow/store.js";
import type { DurableRunRecord, DurableRunStatus } from "../../durable-workflow/types.js";

/**
 * Postgres-backed durable-run store (#338). Implements the {@link DurableRunStore} seam the engine writes
 * through, against the `durable_runs` table. `findOrCreate` leans on `unique(workspace_id, idempotency_key)`
 * for the idempotent start (a repeated key RESUMES the existing run, never forks a duplicate — #200 §2),
 * and `listDue` is the tick's work-list: non-terminal, non-parked runs whose backoff cursor has elapsed.
 * Tenant-scoped throughout (#3). Times cross the seam as epoch ms so the pure engine never touches `Date`.
 */
const NON_TERMINAL: DurableRunStatus[] = ["running", "suspended"];

export const dbDurableRunStore: DurableRunStore = {
  async findOrCreate<TState = unknown, TResult = unknown>(
    input: NewDurableRun<TState>,
  ): Promise<DurableRunRecord<TState, TResult>> {
    const existing = await db
      .select()
      .from(durableRuns)
      .where(
        and(
          eq(durableRuns.workspaceId, input.workspaceId),
          eq(durableRuns.idempotencyKey, input.idempotencyKey),
        ),
      )
      .limit(1);
    if (existing[0]) return toRecord<TState, TResult>(existing[0]);

    const [row] = await db
      .insert(durableRuns)
      .values({
        workspaceId: input.workspaceId,
        workflowKey: input.workflowKey,
        idempotencyKey: input.idempotencyKey,
        status: "running",
        attempts: 0,
        nextAttemptAt: null,
        deadlineAt: new Date(input.deadlineAtMs),
        requiresApproval: input.requiresApproval,
        approvalRequestId: input.approvalRequestId,
        state: input.state as unknown,
        result: null,
        error: null,
        createdAt: new Date(input.nowMs),
        updatedAt: new Date(input.nowMs),
      })
      .onConflictDoNothing({ target: [durableRuns.workspaceId, durableRuns.idempotencyKey] })
      .returning();
    if (row) return toRecord<TState, TResult>(row);

    // Lost an insert race — read the winner back (still idempotent: one run per key).
    const winner = await db
      .select()
      .from(durableRuns)
      .where(
        and(
          eq(durableRuns.workspaceId, input.workspaceId),
          eq(durableRuns.idempotencyKey, input.idempotencyKey),
        ),
      )
      .limit(1);
    const won = winner[0];
    if (!won) throw new Error("durable_runs findOrCreate: insert returned no row and no existing run");
    return toRecord<TState, TResult>(won);
  },

  async get<TState = unknown, TResult = unknown>(
    id: string,
  ): Promise<DurableRunRecord<TState, TResult> | null> {
    const rows = await db.select().from(durableRuns).where(eq(durableRuns.id, id)).limit(1);
    return rows[0] ? toRecord<TState, TResult>(rows[0]) : null;
  },

  async save<TState = unknown, TResult = unknown>(
    record: DurableRunRecord<TState, TResult>,
  ): Promise<DurableRunRecord<TState, TResult>> {
    const [row] = await db
      .update(durableRuns)
      .set({
        status: record.status,
        attempts: record.attempts,
        nextAttemptAt: record.nextAttemptAtMs === null ? null : new Date(record.nextAttemptAtMs),
        deadlineAt: new Date(record.deadlineAtMs),
        requiresApproval: record.requiresApproval,
        approvalRequestId: record.approvalRequestId,
        state: record.state as unknown,
        result: record.result as unknown,
        error: record.error,
        updatedAt: new Date(record.updatedAtMs),
      })
      .where(eq(durableRuns.id, record.id))
      .returning();
    if (!row) throw new Error(`durable_runs save: no row updated for id ${record.id}`);
    return toRecord<TState, TResult>(row);
  },

  async listDue(workspaceId: string, nowMs: number): Promise<DurableRunRecord[]> {
    const now = new Date(nowMs);
    const rows = await db
      .select()
      .from(durableRuns)
      .where(
        and(
          eq(durableRuns.workspaceId, workspaceId),
          inArray(durableRuns.status, NON_TERMINAL),
          or(isNull(durableRuns.nextAttemptAt), lte(durableRuns.nextAttemptAt, now)),
        ),
      );
    return rows.map((r) => toRecord(r));
  },
};

type Row = typeof durableRuns.$inferSelect;

function toRecord<TState = unknown, TResult = unknown>(
  row: Row,
): DurableRunRecord<TState, TResult> {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    workflowKey: row.workflowKey,
    idempotencyKey: row.idempotencyKey,
    status: row.status as DurableRunStatus,
    attempts: row.attempts,
    nextAttemptAtMs: row.nextAttemptAt ? row.nextAttemptAt.getTime() : null,
    deadlineAtMs: row.deadlineAt.getTime(),
    requiresApproval: row.requiresApproval,
    approvalRequestId: row.approvalRequestId,
    state: row.state as TState,
    result: (row.result ?? null) as TResult | null,
    error: row.error,
    createdAtMs: row.createdAt.getTime(),
    updatedAtMs: row.updatedAt.getTime(),
  };
}
