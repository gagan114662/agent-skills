import { and, desc, eq } from "drizzle-orm";
import { db } from "../index.js";
import { newId } from "../id.js";
import { egressViolations } from "../schema/governance.js";

/**
 * Egress audit repo (#151, ADR-0151). Append-only: a row per denied/flagged outbound target — the
 * durable flagged-domains report. Mirrors the `approval_events` discipline: written in the same path
 * as the decision, never updated or deleted.
 */

export interface EgressViolation {
  id: string;
  workspaceId: string;
  sessionId: string | null;
  actorMemberId: string | null;
  target: string;
  domain: string | null;
  reason: string;
  detail: Record<string, unknown>;
  createdAt: Date;
}

/** Record one egress violation (a denied or flagged outbound target). */
export async function recordViolation(input: {
  workspaceId: string;
  target: string;
  domain: string | null;
  reason: string;
  sessionId?: string | null;
  actorMemberId?: string | null;
  detail?: Record<string, unknown>;
}): Promise<EgressViolation> {
  const [row] = await db
    .insert(egressViolations)
    .values({
      id: newId(),
      workspaceId: input.workspaceId,
      sessionId: input.sessionId ?? null,
      actorMemberId: input.actorMemberId ?? null,
      target: input.target,
      domain: input.domain,
      reason: input.reason,
      detail: input.detail ?? {},
    })
    .returning();
  return row as EgressViolation;
}

/**
 * The flagged-domains report: recent violations for a workspace, newest first (cross-tenant safe —
 * always scoped by workspace). `limit` is clamped by the caller's route.
 */
export async function listViolations(
  workspaceId: string,
  opts: { limit?: number } = {},
): Promise<EgressViolation[]> {
  const limit = Math.min(Math.max(opts.limit ?? 100, 1), 500);
  const rows = await db
    .select()
    .from(egressViolations)
    .where(eq(egressViolations.workspaceId, workspaceId))
    .orderBy(desc(egressViolations.createdAt))
    .limit(limit);
  return rows as EgressViolation[];
}

/** Count violations for one domain in a workspace (the report's per-domain rollup). */
export async function countViolationsForDomain(
  workspaceId: string,
  domain: string,
): Promise<number> {
  const rows = await db
    .select({ id: egressViolations.id })
    .from(egressViolations)
    .where(and(eq(egressViolations.workspaceId, workspaceId), eq(egressViolations.domain, domain)));
  return rows.length;
}
