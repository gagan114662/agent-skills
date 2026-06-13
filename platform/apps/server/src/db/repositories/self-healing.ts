import { and, desc, eq, ne } from "drizzle-orm";
import { db } from "../index.js";
import { selfHealingRemediations } from "../schema/index.js";
import type { RemediationStore } from "../../self-healing/engine.js";
import type { HealthSignal, RemediationRecord } from "../../self-healing/types.js";

/**
 * Durable remediation store for Self-Healing Ops (#193, ADR-0174). Implements the {@link RemediationStore}
 * seam over the `self_healing_remediations` table so a breach is a tracked, workspace-scoped row with a
 * lifecycle (`firing` → `remediating` | `escalated` → `resolved`). `getOpen` enforces the
 * one-open-incident-per-`(surface_key, signal)` invariant the partial unique index backs.
 */

const COLUMNS = {
  id: selfHealingRemediations.id,
  workspaceId: selfHealingRemediations.workspaceId,
  surfaceKey: selfHealingRemediations.surfaceKey,
  signal: selfHealingRemediations.signal,
  status: selfHealingRemediations.status,
  action: selfHealingRemediations.action,
  reversibility: selfHealingRemediations.reversibility,
  requiresApproval: selfHealingRemediations.requiresApproval,
  approvalRequestId: selfHealingRemediations.approvalRequestId,
  remediationSessionId: selfHealingRemediations.remediationSessionId,
  attempts: selfHealingRemediations.attempts,
  observedValue: selfHealingRemediations.observedValue,
  thresholdValue: selfHealingRemediations.thresholdValue,
  detail: selfHealingRemediations.detail,
  postmortemIssueRef: selfHealingRemediations.postmortemIssueRef,
  openedAt: selfHealingRemediations.openedAt,
  lastActionAt: selfHealingRemediations.lastActionAt,
  resolvedAt: selfHealingRemediations.resolvedAt,
} as const;

type Patch = Parameters<RemediationStore["update"]>[1];

export async function getOpen(
  workspaceId: string,
  surfaceKey: string,
  signal: HealthSignal,
): Promise<RemediationRecord | null> {
  const [row] = await db
    .select(COLUMNS)
    .from(selfHealingRemediations)
    .where(
      and(
        eq(selfHealingRemediations.workspaceId, workspaceId),
        eq(selfHealingRemediations.surfaceKey, surfaceKey),
        eq(selfHealingRemediations.signal, signal),
        ne(selfHealingRemediations.status, "resolved"),
      ),
    )
    .limit(1);
  return (row as RemediationRecord | undefined) ?? null;
}

export async function open(input: {
  workspaceId: string;
  surfaceKey: string;
  signal: HealthSignal;
  observedValue: number;
  thresholdValue: number;
  now: Date;
}): Promise<RemediationRecord> {
  const [row] = await db
    .insert(selfHealingRemediations)
    .values({
      workspaceId: input.workspaceId,
      surfaceKey: input.surfaceKey,
      signal: input.signal,
      status: "firing",
      requiresApproval: true,
      attempts: 0,
      observedValue: input.observedValue,
      thresholdValue: input.thresholdValue,
      openedAt: input.now,
      lastActionAt: input.now,
    })
    .returning(COLUMNS);
  return row as RemediationRecord;
}

export async function update(id: string, patch: Patch, now: Date): Promise<void> {
  await db
    .update(selfHealingRemediations)
    .set({ ...patch, lastActionAt: now, updatedAt: now })
    .where(eq(selfHealingRemediations.id, id));
}

export async function resolve(id: string, now: Date): Promise<RemediationRecord> {
  const [row] = await db
    .update(selfHealingRemediations)
    .set({ status: "resolved", resolvedAt: now, lastActionAt: now, updatedAt: now })
    .where(eq(selfHealingRemediations.id, id))
    .returning(COLUMNS);
  return row as RemediationRecord;
}

/** Open (non-resolved) incidents for a workspace — the #104 console / daily-brief read surface. */
export async function listOpen(workspaceId: string): Promise<RemediationRecord[]> {
  const rows = await db
    .select(COLUMNS)
    .from(selfHealingRemediations)
    .where(
      and(
        eq(selfHealingRemediations.workspaceId, workspaceId),
        ne(selfHealingRemediations.status, "resolved"),
      ),
    )
    .orderBy(desc(selfHealingRemediations.openedAt))
    .limit(50);
  return rows as RemediationRecord[];
}

/** Recent incidents (any status) for a workspace — the read route + brief history. */
export async function listIncidents(
  workspaceId: string,
  limit = 50,
): Promise<RemediationRecord[]> {
  const rows = await db
    .select(COLUMNS)
    .from(selfHealingRemediations)
    .where(eq(selfHealingRemediations.workspaceId, workspaceId))
    .orderBy(desc(selfHealingRemediations.openedAt))
    .limit(limit);
  return rows as RemediationRecord[];
}

/** The full store, satisfying the engine's {@link RemediationStore} seam. */
export const selfHealingStore: RemediationStore = {
  getOpen,
  open,
  update,
  resolve,
  listOpen,
};
