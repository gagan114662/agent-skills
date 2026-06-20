import { and, desc, eq, gt } from "drizzle-orm";
import { db } from "../index.js";
import { inboundLeads, type InboundLeadStatus } from "../schema/index.js";

/**
 * Inbound lead capture repository (GAP 1 of the leads centre, ADR-0400). Workspace-scoped throughout (the
 * #3 IDOR discipline). The route sanitizes every free-text field (#200 §6, leads/inbound.ts) before it
 * reaches here — this is persistence only. Holds no secret and no money.
 */

export interface RecordLeadInput {
  workspaceId: string;
  name: string | null;
  email: string;
  message: string;
  source: string;
  trackingRef: string | null;
}

export interface InboundLeadRow {
  id: string;
  workspaceId: string;
  name: string | null;
  email: string;
  message: string;
  source: string;
  trackingRef: string | null;
  status: InboundLeadStatus;
  createdAtMs: number;
}

/** Persist a captured lead, returning its new id. A simple insert (no dedup — every hand-raise is real). */
export async function recordLead(input: RecordLeadInput): Promise<{ id: string }> {
  const [row] = await db
    .insert(inboundLeads)
    .values({
      workspaceId: input.workspaceId,
      name: input.name,
      email: input.email,
      message: input.message,
      source: input.source,
      trackingRef: input.trackingRef,
    })
    .returning({ id: inboundLeads.id });
  return { id: row?.id ?? "" };
}

/** List captured leads for a workspace, newest first, optionally only those after `sinceMs`. */
export async function listLeads(workspaceId: string, sinceMs?: number): Promise<InboundLeadRow[]> {
  const conds = [eq(inboundLeads.workspaceId, workspaceId)];
  if (sinceMs !== undefined) conds.push(gt(inboundLeads.createdAt, new Date(sinceMs)));
  const rows = await db
    .select()
    .from(inboundLeads)
    .where(and(...conds))
    .orderBy(desc(inboundLeads.createdAt))
    .limit(500);
  return rows.map((r) => ({
    id: r.id,
    workspaceId: r.workspaceId,
    name: r.name,
    email: r.email,
    message: r.message,
    source: r.source,
    trackingRef: r.trackingRef,
    status: r.status,
    createdAtMs: r.createdAt.getTime(),
  }));
}
