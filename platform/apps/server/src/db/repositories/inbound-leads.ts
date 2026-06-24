import { and, desc, eq, gt, isNull } from "drizzle-orm";
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
  emailHash?: string | null;
  submitterHash?: string | null;
  verificationTokenHash?: string | null;
  verificationSentAt?: Date | null;
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
  verified: boolean;
  verifiedAtMs: number | null;
  status: InboundLeadStatus;
  assigneeMemberId: string | null;
  nextAction: string | null;
  respondedAtMs: number | null;
  slaDueAtMs: number;
  slaNotifiedAtMs: number | null;
  slaBreached: boolean;
  reachContactKey: string;
  createdAtMs: number;
}

export interface ListLeadsOptions {
  status?: InboundLeadStatus;
  sinceMs?: number;
  limit?: number;
}

export interface UpdateLeadInput {
  status?: InboundLeadStatus;
  assigneeMemberId?: string | null;
  nextAction?: string | null;
  respondedAt?: Date | null;
}

const SLA_MS = 24 * 60 * 60 * 1000;

function reachKey(email: string): string {
  return `email:${email.trim().toLowerCase()}`;
}

function toRow(r: typeof inboundLeads.$inferSelect): InboundLeadRow {
  const due = r.slaDueAt ?? new Date(r.createdAt.getTime() + SLA_MS);
  return {
    id: r.id,
    workspaceId: r.workspaceId,
    name: r.name,
    email: r.email,
    message: r.message,
    source: r.source,
    trackingRef: r.trackingRef,
    verified: r.verified,
    verifiedAtMs: r.verifiedAt ? r.verifiedAt.getTime() : null,
    status: r.status as InboundLeadStatus,
    assigneeMemberId: r.assigneeMemberId,
    nextAction: r.nextAction,
    respondedAtMs: r.respondedAt ? r.respondedAt.getTime() : null,
    slaDueAtMs: due.getTime(),
    slaNotifiedAtMs: r.slaNotifiedAt ? r.slaNotifiedAt.getTime() : null,
    slaBreached: !r.respondedAt && due.getTime() < Date.now(),
    reachContactKey: r.reachContactKey ?? reachKey(r.email),
    createdAtMs: r.createdAt.getTime(),
  };
}

/** Persist a captured lead, returning its new id. Public intake starts unverified until the email link is clicked. */
export async function recordLead(input: RecordLeadInput): Promise<{ id: string }> {
  const now = new Date();
  const [row] = await db
    .insert(inboundLeads)
    .values({
      workspaceId: input.workspaceId,
      name: input.name,
      email: input.email,
      emailHash: input.emailHash ?? null,
      submitterHash: input.submitterHash ?? null,
      verified: false,
      verificationTokenHash: input.verificationTokenHash ?? null,
      verificationSentAt: input.verificationSentAt ?? null,
      message: input.message,
      source: input.source,
      trackingRef: input.trackingRef,
      slaDueAt: new Date(now.getTime() + SLA_MS),
      reachContactKey: reachKey(input.email),
    })
    .returning({ id: inboundLeads.id });
  return { id: row?.id ?? "" };
}

export async function findRecentLeadDuplicate(input: {
  workspaceId: string;
  emailHash: string;
  submitterHash: string;
  since: Date;
}): Promise<{ id: string } | null> {
  const [row] = await db
    .select({ id: inboundLeads.id })
    .from(inboundLeads)
    .where(
      and(
        eq(inboundLeads.workspaceId, input.workspaceId),
        eq(inboundLeads.emailHash, input.emailHash),
        eq(inboundLeads.submitterHash, input.submitterHash),
        gt(inboundLeads.createdAt, input.since),
      ),
    )
    .orderBy(desc(inboundLeads.createdAt))
    .limit(1);
  return row ?? null;
}

export async function verifyLeadByTokenHash(tokenHash: string): Promise<InboundLeadRow | null> {
  const [row] = await db
    .update(inboundLeads)
    .set({ verified: true, verifiedAt: new Date(), verificationTokenHash: null })
    .where(and(eq(inboundLeads.verificationTokenHash, tokenHash), eq(inboundLeads.verified, false)))
    .returning();
  return row ? toRow(row) : null;
}

/** List captured leads for a workspace, newest first, optionally only those after `sinceMs`. */
export async function listLeads(workspaceId: string, opts: ListLeadsOptions = {}): Promise<InboundLeadRow[]> {
  const conds = [eq(inboundLeads.workspaceId, workspaceId)];
  if (opts.sinceMs !== undefined) conds.push(gt(inboundLeads.createdAt, new Date(opts.sinceMs)));
  if (opts.status) conds.push(eq(inboundLeads.status, opts.status));
  const rows = await db
    .select()
    .from(inboundLeads)
    .where(and(...conds))
    .orderBy(desc(inboundLeads.createdAt))
    .limit(Math.max(1, Math.min(opts.limit ?? 100, 500)));
  return rows.map(toRow);
}

export async function getLead(workspaceId: string, id: string): Promise<InboundLeadRow | null> {
  const [row] = await db
    .select()
    .from(inboundLeads)
    .where(and(eq(inboundLeads.workspaceId, workspaceId), eq(inboundLeads.id, id)))
    .limit(1);
  return row ? toRow(row) : null;
}

export async function updateLead(
  workspaceId: string,
  id: string,
  update: UpdateLeadInput,
): Promise<InboundLeadRow | null> {
  const patch: Partial<typeof inboundLeads.$inferInsert> = {};
  if (update.status !== undefined) patch.status = update.status;
  if (update.assigneeMemberId !== undefined) patch.assigneeMemberId = update.assigneeMemberId;
  if (update.nextAction !== undefined) patch.nextAction = update.nextAction;
  if (update.respondedAt !== undefined) patch.respondedAt = update.respondedAt;
  if (update.status === "converted" || update.status === "archived") patch.respondedAt = update.respondedAt ?? new Date();
  const [row] = await db
    .update(inboundLeads)
    .set(patch)
    .where(and(eq(inboundLeads.workspaceId, workspaceId), eq(inboundLeads.id, id)))
    .returning();
  return row ? toRow(row) : null;
}

/** Mark that the owner was alerted about a lead's 24h SLA breach. Idempotent and workspace-scoped. */
export async function markSlaNotified(workspaceId: string, id: string): Promise<boolean> {
  const rows = await db
    .update(inboundLeads)
    .set({ slaNotifiedAt: new Date() })
    .where(and(eq(inboundLeads.workspaceId, workspaceId), eq(inboundLeads.id, id), isNull(inboundLeads.slaNotifiedAt)))
    .returning({ id: inboundLeads.id });
  return rows.length > 0;
}
