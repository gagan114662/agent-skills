import { and, desc, eq, ne } from "drizzle-orm";
import { db } from "../index.js";
import { sreIncidents } from "../schema/index.js";
import type { SreIncidentStore } from "../../sre/engine.js";
import type { IncidentRecord, SloKind } from "../../sre/types.js";

/**
 * Durable incident store for the SRE Loop (#112, ADR-0112). Implements the {@link SreIncidentStore}
 * seam over the `sre_incidents` table so a breach is a tracked, workspace-scoped row with a lifecycle.
 * `getOpen` enforces the one-open-incident-per-`service+slo` invariant the partial unique index backs.
 */

const COLUMNS = {
  id: sreIncidents.id,
  workspaceId: sreIncidents.workspaceId,
  service: sreIncidents.service,
  sloKind: sreIncidents.sloKind,
  severity: sreIncidents.severity,
  status: sreIncidents.status,
  observedValue: sreIncidents.observedValue,
  targetValue: sreIncidents.targetValue,
  budgetRemaining: sreIncidents.budgetRemaining,
  triageSessionId: sreIncidents.triageSessionId,
  postmortemPath: sreIncidents.postmortemPath,
  openedAt: sreIncidents.openedAt,
  lastNotifiedAt: sreIncidents.lastNotifiedAt,
  resolvedAt: sreIncidents.resolvedAt,
} as const;

export async function getOpen(
  workspaceId: string,
  service: string,
  sloKind: SloKind,
): Promise<IncidentRecord | null> {
  const [row] = await db
    .select(COLUMNS)
    .from(sreIncidents)
    .where(
      and(
        eq(sreIncidents.workspaceId, workspaceId),
        eq(sreIncidents.service, service),
        eq(sreIncidents.sloKind, sloKind),
        ne(sreIncidents.status, "resolved"),
      ),
    )
    .limit(1);
  return (row as IncidentRecord | undefined) ?? null;
}

export async function open(input: {
  workspaceId: string;
  service: string;
  sloKind: SloKind;
  severity: IncidentRecord["severity"];
  observedValue: number;
  targetValue: number;
  budgetRemaining: number;
  now: Date;
}): Promise<IncidentRecord> {
  const [row] = await db
    .insert(sreIncidents)
    .values({
      workspaceId: input.workspaceId,
      service: input.service,
      sloKind: input.sloKind,
      severity: input.severity,
      status: "firing",
      observedValue: input.observedValue,
      targetValue: input.targetValue,
      budgetRemaining: input.budgetRemaining,
      openedAt: input.now,
      lastNotifiedAt: input.now,
    })
    .returning(COLUMNS);
  return row as IncidentRecord;
}

export async function attachTriage(id: string, triageSessionId: string): Promise<void> {
  await db
    .update(sreIncidents)
    .set({ triageSessionId, updatedAt: new Date() })
    .where(eq(sreIncidents.id, id));
}

export async function markEscalated(id: string): Promise<void> {
  await db
    .update(sreIncidents)
    .set({ status: "escalated", updatedAt: new Date() })
    .where(eq(sreIncidents.id, id));
}

export async function recordNotified(id: string, now: Date): Promise<void> {
  await db
    .update(sreIncidents)
    .set({ lastNotifiedAt: now, updatedAt: now })
    .where(eq(sreIncidents.id, id));
}

export async function resolve(input: {
  id: string;
  postmortemPath: string;
  now: Date;
}): Promise<IncidentRecord> {
  const [row] = await db
    .update(sreIncidents)
    .set({
      status: "resolved",
      postmortemPath: input.postmortemPath,
      resolvedAt: input.now,
      updatedAt: input.now,
    })
    .where(eq(sreIncidents.id, input.id))
    .returning(COLUMNS);
  return row as IncidentRecord;
}

/** List incidents for a workspace (most-recent first) — the read surface for the SRE route. */
export async function listIncidents(
  workspaceId: string,
  opts: { status?: IncidentRecord["status"]; limit?: number } = {},
): Promise<IncidentRecord[]> {
  const where = opts.status
    ? and(eq(sreIncidents.workspaceId, workspaceId), eq(sreIncidents.status, opts.status))
    : eq(sreIncidents.workspaceId, workspaceId);
  const rows = await db
    .select(COLUMNS)
    .from(sreIncidents)
    .where(where)
    .orderBy(desc(sreIncidents.openedAt))
    .limit(opts.limit ?? 50);
  return rows as IncidentRecord[];
}

/** Resolved incidents that have a drafted postmortem — the Founder Console's link list. */
export async function listPostmortems(
  workspaceId: string,
  limit = 10,
): Promise<IncidentRecord[]> {
  const rows = await db
    .select(COLUMNS)
    .from(sreIncidents)
    .where(and(eq(sreIncidents.workspaceId, workspaceId), eq(sreIncidents.status, "resolved")))
    .orderBy(desc(sreIncidents.resolvedAt))
    .limit(limit);
  return (rows as IncidentRecord[]).filter((r) => r.postmortemPath !== null);
}

/** The full store, satisfying the engine's {@link SreIncidentStore} seam. */
export const sreIncidentStore: SreIncidentStore = {
  getOpen,
  open,
  attachTriage,
  markEscalated,
  recordNotified,
  resolve,
};
