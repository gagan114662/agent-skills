import { and, asc, desc, eq, gte, sql } from "drizzle-orm";
import { db } from "../index.js";
import { reliabilityIncidents, reliabilityPages, members, users } from "../schema/index.js";

/**
 * Reliability surface persistence (#148, ADR-0148): the incident overlay + the page audit/rate-limit
 * log, plus the owner-contact join (there is no first-class owner column, so the earliest human member
 * of the workspace is the owner, joined to `users.email`). All queries are workspace-scoped.
 */

export interface ReliabilityOverlay {
  id: string;
  workspaceId: string;
  incidentId: string;
  seq: number;
  channelId: string | null;
  investigationNote: string | null;
  lastPagedAt: Date | null;
  ackedAt: Date | null;
  pageCount: number;
}

export interface OwnerContact {
  memberId: string;
  email: string;
  displayName: string;
}

const OVERLAY_COLUMNS = {
  id: reliabilityIncidents.id,
  workspaceId: reliabilityIncidents.workspaceId,
  incidentId: reliabilityIncidents.incidentId,
  seq: reliabilityIncidents.seq,
  channelId: reliabilityIncidents.channelId,
  investigationNote: reliabilityIncidents.investigationNote,
  lastPagedAt: reliabilityIncidents.lastPagedAt,
  ackedAt: reliabilityIncidents.ackedAt,
  pageCount: reliabilityIncidents.pageCount,
} as const;

/** The overlay for an incident, or null. */
export async function getOverlay(incidentId: string): Promise<ReliabilityOverlay | null> {
  const [row] = await db
    .select(OVERLAY_COLUMNS)
    .from(reliabilityIncidents)
    .where(eq(reliabilityIncidents.incidentId, incidentId))
    .limit(1);
  return (row as ReliabilityOverlay | undefined) ?? null;
}

/**
 * Get-or-create the overlay for an incident. The per-workspace `seq` (which names `#incident-NNN`) is
 * the next integer after the workspace's current overlay count, computed inside a transaction so two
 * concurrent opens don't collide on the channel name.
 */
export async function ensureOverlay(
  workspaceId: string,
  incidentId: string,
): Promise<ReliabilityOverlay> {
  return db.transaction(async (tx) => {
    const [existing] = await tx
      .select(OVERLAY_COLUMNS)
      .from(reliabilityIncidents)
      .where(eq(reliabilityIncidents.incidentId, incidentId))
      .limit(1);
    if (existing) return existing as ReliabilityOverlay;

    const countRows = await tx
      .select({ count: sql<number>`count(*)::int` })
      .from(reliabilityIncidents)
      .where(eq(reliabilityIncidents.workspaceId, workspaceId));
    const seq = (countRows[0]?.count ?? 0) + 1;

    const [row] = await tx
      .insert(reliabilityIncidents)
      .values({ workspaceId, incidentId, seq })
      .returning(OVERLAY_COLUMNS);
    return row as ReliabilityOverlay;
  });
}

export async function setOverlayChannel(id: string, channelId: string): Promise<void> {
  await db
    .update(reliabilityIncidents)
    .set({ channelId, updatedAt: new Date() })
    .where(eq(reliabilityIncidents.id, id));
}

export async function setInvestigationNote(id: string, note: string): Promise<void> {
  await db
    .update(reliabilityIncidents)
    .set({ investigationNote: note, updatedAt: new Date() })
    .where(eq(reliabilityIncidents.id, id));
}

export async function recordOverlayPaged(id: string, now: Date): Promise<void> {
  await db
    .update(reliabilityIncidents)
    .set({ lastPagedAt: now, pageCount: sql`${reliabilityIncidents.pageCount} + 1`, updatedAt: now })
    .where(eq(reliabilityIncidents.id, id));
}

/** Acknowledge an incident (workspace-scoped for the route guard) — stops the escalation re-page. */
export async function ackIncident(
  workspaceId: string,
  incidentId: string,
  now: Date,
): Promise<ReliabilityOverlay | null> {
  const overlay = await ensureOverlay(workspaceId, incidentId);
  const [row] = await db
    .update(reliabilityIncidents)
    .set({ ackedAt: now, updatedAt: now })
    .where(
      and(
        eq(reliabilityIncidents.id, overlay.id),
        eq(reliabilityIncidents.workspaceId, workspaceId),
      ),
    )
    .returning(OVERLAY_COLUMNS);
  return (row as ReliabilityOverlay | undefined) ?? null;
}

/** Count pages delivered for a workspace since `since` (the rate-limit window). */
export async function countPagesSince(workspaceId: string, since: Date): Promise<number> {
  const rows = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(reliabilityPages)
    .where(
      and(
        eq(reliabilityPages.workspaceId, workspaceId),
        eq(reliabilityPages.delivered, true),
        gte(reliabilityPages.createdAt, since),
      ),
    );
  return rows[0]?.count ?? 0;
}

/** Append a page-attempt audit row (delivered or suppressed). */
export async function recordPage(input: {
  workspaceId: string;
  source: "sre" | "uptime";
  incidentId: string | null;
  kind: "opened" | "repaged" | "resolved" | "uptime_down" | "uptime_recover";
  recipient: string;
  delivered: boolean;
  suppressedReason: string | null;
}): Promise<void> {
  await db.insert(reliabilityPages).values({
    workspaceId: input.workspaceId,
    source: input.source,
    incidentId: input.incidentId,
    kind: input.kind,
    recipient: input.recipient,
    delivered: input.delivered,
    suppressedReason: input.suppressedReason,
  });
}

/** Recent pages for a workspace (audit read), newest first. */
export async function listPages(workspaceId: string, limit = 50) {
  return db
    .select()
    .from(reliabilityPages)
    .where(eq(reliabilityPages.workspaceId, workspaceId))
    .orderBy(desc(reliabilityPages.createdAt))
    .limit(limit);
}

/**
 * The workspace owner's verified contact: the earliest human member joined to `users.email`. There is
 * no first-class owner column, so "earliest human" is the owner heuristic. Null when the workspace has
 * no human member (e.g. an all-agent fixture).
 */
export async function getWorkspaceOwnerContact(workspaceId: string): Promise<OwnerContact | null> {
  const [row] = await db
    .select({ memberId: members.id, email: users.email, displayName: members.displayName })
    .from(members)
    .innerJoin(users, eq(members.userId, users.id))
    .where(and(eq(members.workspaceId, workspaceId), eq(members.kind, "human")))
    .orderBy(asc(members.createdAt))
    .limit(1);
  return (row as OwnerContact | undefined) ?? null;
}
