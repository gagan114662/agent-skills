import { and, desc, eq, ne, sql } from "drizzle-orm";
import { db } from "../index.js";
import { failureFingerprints, flywheelFixDispatches } from "../schema/index.js";
import type {
  FingerprintStore,
  FixDispatchStore,
} from "../../flywheel/engine.js";
import type { FingerprintRecord, FixDispatchRecord } from "../../flywheel/types.js";

/**
 * Durable stores for the Self-Healing Flywheel (#117, ADR-0117). Implement the {@link FingerprintStore}
 * and {@link FixDispatchStore} engine seams over `failure_fingerprints` / `flywheel_fix_dispatches`.
 * Every query filters `workspace_id` (the #3 tenant boundary). The dedup contract — ONE row per
 * `(workspace_id, signature)` — is the table's UNIQUE constraint; the engine reads/writes through here.
 */

const FP_COLUMNS = {
  id: failureFingerprints.id,
  workspaceId: failureFingerprints.workspaceId,
  signature: failureFingerprints.signature,
  failureClass: failureFingerprints.failureClass,
  title: failureFingerprints.title,
  firstSeenAt: failureFingerprints.firstSeenAt,
  lastSeenAt: failureFingerprints.lastSeenAt,
  occurrenceCount: failureFingerprints.occurrenceCount,
  sampleContext: failureFingerprints.sampleContext,
  status: failureFingerprints.status,
  originChannelId: failureFingerprints.originChannelId,
  originAgentMemberId: failureFingerprints.originAgentMemberId,
  issueRef: failureFingerprints.issueRef,
  issueState: failureFingerprints.issueState,
  syncedOccurrenceCount: failureFingerprints.syncedOccurrenceCount,
  fixSessionId: failureFingerprints.fixSessionId,
  fixRef: failureFingerprints.fixRef,
  fixedAt: failureFingerprints.fixedAt,
  excludedFromAutoDispatch: failureFingerprints.excludedFromAutoDispatch,
  escalated: failureFingerprints.escalated,
} as const;

export async function getBySignature(
  workspaceId: string,
  signature: string,
): Promise<FingerprintRecord | null> {
  const [row] = await db
    .select(FP_COLUMNS)
    .from(failureFingerprints)
    .where(
      and(
        eq(failureFingerprints.workspaceId, workspaceId),
        eq(failureFingerprints.signature, signature),
      ),
    )
    .limit(1);
  return (row as FingerprintRecord | undefined) ?? null;
}

export async function get(workspaceId: string, id: string): Promise<FingerprintRecord | null> {
  const [row] = await db
    .select(FP_COLUMNS)
    .from(failureFingerprints)
    .where(and(eq(failureFingerprints.workspaceId, workspaceId), eq(failureFingerprints.id, id)))
    .limit(1);
  return (row as FingerprintRecord | undefined) ?? null;
}

const fingerprintStoreImpl: FingerprintStore = {
  getBySignature,
  get,

  async insert(input) {
    const [row] = await db
      .insert(failureFingerprints)
      .values({
        workspaceId: input.workspaceId,
        signature: input.signature,
        failureClass: input.failureClass,
        title: input.title,
        sampleContext: input.sampleContext,
        originChannelId: input.originChannelId ?? null,
        originAgentMemberId: input.originAgentMemberId ?? null,
        occurrenceCount: 1,
        syncedOccurrenceCount: 0,
        status: "open",
        firstSeenAt: input.now,
        lastSeenAt: input.now,
        createdAt: input.now,
        updatedAt: input.now,
      })
      .returning(FP_COLUMNS);
    return row as FingerprintRecord;
  },

  async touch(input) {
    const [row] = await db
      .update(failureFingerprints)
      .set({
        occurrenceCount: sql`${failureFingerprints.occurrenceCount} + 1`,
        lastSeenAt: input.now,
        updatedAt: input.now,
      })
      .where(eq(failureFingerprints.id, input.id))
      .returning(FP_COLUMNS);
    return row as FingerprintRecord;
  },

  async markRecurred(input) {
    const [row] = await db
      .update(failureFingerprints)
      .set({
        status: "recurred",
        excludedFromAutoDispatch: true,
        escalated: true,
        lastSeenAt: input.now,
        updatedAt: input.now,
      })
      .where(eq(failureFingerprints.id, input.id))
      .returning(FP_COLUMNS);
    return row as FingerprintRecord;
  },

  async listOpen(workspaceId) {
    const rows = await db
      .select(FP_COLUMNS)
      .from(failureFingerprints)
      .where(
        and(
          eq(failureFingerprints.workspaceId, workspaceId),
          ne(failureFingerprints.status, "fixed"),
        ),
      );
    return rows as FingerprintRecord[];
  },

  async recordIssue(input) {
    await db
      .update(failureFingerprints)
      .set({
        issueRef: input.issueRef,
        issueState: input.issueState,
        status: input.status,
        syncedOccurrenceCount: input.syncedOccurrenceCount,
        updatedAt: input.now,
      })
      .where(eq(failureFingerprints.id, input.id));
  },

  async linkFix(input) {
    await db
      .update(failureFingerprints)
      .set({ fixSessionId: input.fixSessionId, status: "fixing", updatedAt: input.now })
      .where(eq(failureFingerprints.id, input.id));
  },

  async markFixed(input) {
    const [row] = await db
      .update(failureFingerprints)
      .set({ status: "fixed", fixRef: input.fixRef, fixedAt: input.now, updatedAt: input.now })
      .where(eq(failureFingerprints.id, input.id))
      .returning(FP_COLUMNS);
    return row as FingerprintRecord;
  },

  async listForConsole(workspaceId) {
    const rows = await db
      .select(FP_COLUMNS)
      .from(failureFingerprints)
      .where(eq(failureFingerprints.workspaceId, workspaceId))
      .orderBy(desc(failureFingerprints.lastSeenAt))
      .limit(50);
    return rows as FingerprintRecord[];
  },
};

/** Workspaces with at least one non-terminal fingerprint — the flywheel tick work-list. */
export async function listActiveWorkspaces(): Promise<string[]> {
  const rows = await db
    .selectDistinct({ workspaceId: failureFingerprints.workspaceId })
    .from(failureFingerprints)
    .where(ne(failureFingerprints.status, "fixed"));
  return rows.map((r) => r.workspaceId);
}

export const flywheelFingerprintStore = fingerprintStoreImpl;

// --- fix dispatch ledger ------------------------------------------------------------------------

const DISPATCH_COLUMNS = {
  id: flywheelFixDispatches.id,
  workspaceId: flywheelFixDispatches.workspaceId,
  fingerprintId: flywheelFixDispatches.fingerprintId,
  mode: flywheelFixDispatches.mode,
  status: flywheelFixDispatches.status,
  sessionId: flywheelFixDispatches.sessionId,
  approvalRequestId: flywheelFixDispatches.approvalRequestId,
  reason: flywheelFixDispatches.reason,
  createdAt: flywheelFixDispatches.createdAt,
} as const;

export const flywheelDispatchStore: FixDispatchStore = {
  async create(input) {
    const [row] = await db
      .insert(flywheelFixDispatches)
      .values({
        workspaceId: input.workspaceId,
        fingerprintId: input.fingerprintId,
        mode: input.mode,
        status: input.status,
        sessionId: input.sessionId ?? null,
        approvalRequestId: input.approvalRequestId ?? null,
        reason: input.reason,
        createdAt: input.now,
      })
      .returning(DISPATCH_COLUMNS);
    return row as FixDispatchRecord;
  },

  async countActive(workspaceId) {
    const [row] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(flywheelFixDispatches)
      .where(
        and(
          eq(flywheelFixDispatches.workspaceId, workspaceId),
          eq(flywheelFixDispatches.mode, "auto"),
          eq(flywheelFixDispatches.status, "dispatched"),
        ),
      );
    return row?.count ?? 0;
  },

  async listForConsole(workspaceId) {
    const rows = await db
      .select(DISPATCH_COLUMNS)
      .from(flywheelFixDispatches)
      .where(eq(flywheelFixDispatches.workspaceId, workspaceId))
      .orderBy(desc(flywheelFixDispatches.createdAt))
      .limit(50);
    return rows as FixDispatchRecord[];
  },
};
