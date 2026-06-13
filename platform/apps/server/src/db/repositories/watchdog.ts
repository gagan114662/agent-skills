import { and, eq } from "drizzle-orm";
import { db } from "../index.js";
import { watchdogRevivals } from "../schema/index.js";
import { windowExpired } from "../../watchdog/guards.js";
import type { RevivalRecord, WatchdogRevivalStore } from "../../watchdog/engine.js";

/**
 * Durable revival-lineage store for the Fleet Watchdog (#105, ADR-0105). Implements the
 * {@link WatchdogRevivalStore} seam over the `watchdog_revivals` table so the bounded restart policy
 * survives a process restart. The window reset lives here (the repo owns the rolling-window write),
 * reusing the pure {@link windowExpired} guard so the policy is consistent with `decide`.
 */

const COLUMNS = {
  id: watchdogRevivals.id,
  workspaceId: watchdogRevivals.workspaceId,
  rootSessionId: watchdogRevivals.rootSessionId,
  currentSessionId: watchdogRevivals.currentSessionId,
  revivals: watchdogRevivals.revivals,
  windowStartedAt: watchdogRevivals.windowStartedAt,
  lastRevivalAt: watchdogRevivals.lastRevivalAt,
  lastErrorClass: watchdogRevivals.lastErrorClass,
  status: watchdogRevivals.status,
} as const;

export async function getByCurrentSession(
  workspaceId: string,
  sessionId: string,
): Promise<RevivalRecord | null> {
  const [row] = await db
    .select(COLUMNS)
    .from(watchdogRevivals)
    .where(
      and(
        eq(watchdogRevivals.workspaceId, workspaceId),
        eq(watchdogRevivals.currentSessionId, sessionId),
      ),
    )
    .limit(1);
  return (row as RevivalRecord | undefined) ?? null;
}

export async function createForRoot(input: {
  workspaceId: string;
  rootSessionId: string;
  errorClass: string;
}): Promise<RevivalRecord> {
  const [row] = await db
    .insert(watchdogRevivals)
    .values({
      workspaceId: input.workspaceId,
      rootSessionId: input.rootSessionId,
      currentSessionId: input.rootSessionId,
      revivals: 0,
      lastErrorClass: input.errorClass,
      status: "active",
    })
    .returning(COLUMNS);
  return row as RevivalRecord;
}

export async function recordRevival(input: {
  id: string;
  newSessionId: string;
  windowMs: number;
  errorClass: string;
  now: Date;
}): Promise<RevivalRecord> {
  const [current] = await db
    .select(COLUMNS)
    .from(watchdogRevivals)
    .where(eq(watchdogRevivals.id, input.id))
    .limit(1);
  const record = current as RevivalRecord;
  // Reset the rolling window if it has elapsed; otherwise count up within it.
  const windowAge = input.now.getTime() - record.windowStartedAt.getTime();
  const reset = windowExpired(windowAge, input.windowMs);
  const [row] = await db
    .update(watchdogRevivals)
    .set({
      currentSessionId: input.newSessionId,
      revivals: reset ? 1 : record.revivals + 1,
      windowStartedAt: reset ? input.now : record.windowStartedAt,
      lastRevivalAt: input.now,
      lastErrorClass: input.errorClass,
      status: "active",
      updatedAt: input.now,
    })
    .where(eq(watchdogRevivals.id, input.id))
    .returning(COLUMNS);
  return row as RevivalRecord;
}

export async function markEscalated(id: string): Promise<void> {
  await db
    .update(watchdogRevivals)
    .set({ status: "escalated", updatedAt: new Date() })
    .where(eq(watchdogRevivals.id, id));
}

/**
 * Count the stuck-agent lineages the watchdog escalated for a workspace (#193): a revival lineage that
 * hit its retry cap and was handed to a human is the "fleet-health red" signal the #104 console reads.
 */
export async function countEscalatedRevivals(workspaceId: string): Promise<number> {
  const rows = await db
    .select({ id: watchdogRevivals.id })
    .from(watchdogRevivals)
    .where(
      and(eq(watchdogRevivals.workspaceId, workspaceId), eq(watchdogRevivals.status, "escalated")),
    );
  return rows.length;
}

/** The full store, satisfying the engine's {@link WatchdogRevivalStore} seam. */
export const watchdogRevivalStore: WatchdogRevivalStore = {
  getByCurrentSession,
  createForRoot,
  recordRevival,
  markEscalated,
};
