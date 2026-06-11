import { and, eq, inArray, sql } from "drizzle-orm";
import { db } from "../index.js";
import { tenantUsage } from "../schema/index.js";
import { EMPTY_USAGE, type UsageSnapshot, type UsageStore } from "../../scale/usage.js";
import type { UsageTrendPoint } from "../../scale/forecast.js";

/**
 * Per-tenant usage repository (#71) — the {@link UsageStore} the production `UsageRecorder` and the
 * usage dashboard are built on. Increments are **upserts** keyed by (workspace, window), so two
 * sessions finalizing concurrently accumulate correctly without a read-modify-write race.
 */

/** Read a tenant's accrued usage for a window (absent row → all zeros). */
export async function getUsage(workspaceId: string, windowKey: string): Promise<UsageSnapshot> {
  const [row] = await db
    .select({
      sessionsStarted: tenantUsage.sessionsStarted,
      computeSeconds: tenantUsage.computeSeconds,
      estimatedCostCents: tenantUsage.estimatedCostCents,
    })
    .from(tenantUsage)
    .where(and(eq(tenantUsage.workspaceId, workspaceId), eq(tenantUsage.windowKey, windowKey)))
    .limit(1);
  return row ?? EMPTY_USAGE;
}

/**
 * Read a tenant's usage across a set of windows for the #113 cost forecast (oldest→newest by window).
 * Additive read — no new authority, no mutation. Absent windows are simply not returned (the pure
 * `forecastUsage` handles a sparse/short trend).
 */
export async function getUsageTrend(
  workspaceId: string,
  windowKeys: string[],
): Promise<UsageTrendPoint[]> {
  if (windowKeys.length === 0) return [];
  const rows = await db
    .select({
      window: tenantUsage.windowKey,
      computeSeconds: tenantUsage.computeSeconds,
      estimatedCostCents: tenantUsage.estimatedCostCents,
      sessionsStarted: tenantUsage.sessionsStarted,
    })
    .from(tenantUsage)
    .where(and(eq(tenantUsage.workspaceId, workspaceId), inArray(tenantUsage.windowKey, windowKeys)));
  return rows.sort((a, b) => (a.window < b.window ? -1 : a.window > b.window ? 1 : 0));
}

/** Count one admitted launch this window (upsert-increment). */
export async function recordSessionStart(workspaceId: string, windowKey: string): Promise<void> {
  await db
    .insert(tenantUsage)
    .values({ workspaceId, windowKey, sessionsStarted: 1 })
    .onConflictDoUpdate({
      target: [tenantUsage.workspaceId, tenantUsage.windowKey],
      set: { sessionsStarted: sql`${tenantUsage.sessionsStarted} + 1`, updatedAt: new Date() },
    });
}

/** Add a finalized session's compute-seconds + estimated cost this window (upsert-increment). */
export async function recordSessionCompute(
  workspaceId: string,
  windowKey: string,
  computeSeconds: number,
  costCents: number,
): Promise<void> {
  const seconds = Math.max(0, Math.round(computeSeconds));
  const cost = Math.max(0, Math.round(costCents));
  await db
    .insert(tenantUsage)
    .values({ workspaceId, windowKey, computeSeconds: seconds, estimatedCostCents: cost })
    .onConflictDoUpdate({
      target: [tenantUsage.workspaceId, tenantUsage.windowKey],
      set: {
        computeSeconds: sql`${tenantUsage.computeSeconds} + ${seconds}`,
        estimatedCostCents: sql`${tenantUsage.estimatedCostCents} + ${cost}`,
        updatedAt: new Date(),
      },
    });
}

/** The repo-backed {@link UsageStore} (the production usage persistence). */
export const usageStore: UsageStore = {
  read: getUsage,
  recordStart: recordSessionStart,
  recordCompute: recordSessionCompute,
};
