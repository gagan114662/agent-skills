import { and, eq } from "drizzle-orm";
import { db } from "../index.js";
import { newId } from "../id.js";
import { members } from "../schema/identities.js";
import { workspaceMemberRoles, workspaceInvites } from "../schema/governance.js";
import type { WorkspaceRole, InviteStatus } from "../../team/rbac.js";

/**
 * Teams/RBAC repo (#151, ADR-0151). Role grants + email invites — both additive, workspace-scoped,
 * cross-tenant safe (every query is filtered by workspace_id). No secrets: the invite stores only the
 * sha-256 hash of the raw token (the raw is shown once at creation and never persisted).
 */

export interface MemberRoleRow {
  memberId: string;
  role: WorkspaceRole;
  displayName: string;
  kind: "human" | "agent";
}

export interface InviteRow {
  id: string;
  workspaceId: string;
  email: string;
  role: WorkspaceRole;
  status: InviteStatus;
  invitedByMemberId: string | null;
  acceptedMemberId: string | null;
  createdAt: Date;
  acceptedAt: Date | null;
}

/** The caller's role in a workspace, or null when they have no role row (the default). */
export async function getMemberRole(
  workspaceId: string,
  memberId: string,
): Promise<WorkspaceRole | null> {
  const [row] = await db
    .select({ role: workspaceMemberRoles.role })
    .from(workspaceMemberRoles)
    .where(
      and(
        eq(workspaceMemberRoles.workspaceId, workspaceId),
        eq(workspaceMemberRoles.memberId, memberId),
      ),
    )
    .limit(1);
  return (row?.role as WorkspaceRole | undefined) ?? null;
}

/** Upsert a member's role (one row per workspace+member). Returns the assigned role. */
export async function setMemberRole(input: {
  workspaceId: string;
  memberId: string;
  role: WorkspaceRole;
  grantedByMemberId: string | null;
}): Promise<WorkspaceRole> {
  await db
    .insert(workspaceMemberRoles)
    .values({
      id: newId(),
      workspaceId: input.workspaceId,
      memberId: input.memberId,
      role: input.role,
      grantedByMemberId: input.grantedByMemberId,
    })
    .onConflictDoUpdate({
      target: [workspaceMemberRoles.workspaceId, workspaceMemberRoles.memberId],
      set: { role: input.role, grantedByMemberId: input.grantedByMemberId, updatedAt: new Date() },
    });
  return input.role;
}

/** Remove a member's role grant (back to the default "no role"). */
export async function removeMemberRole(workspaceId: string, memberId: string): Promise<void> {
  await db
    .delete(workspaceMemberRoles)
    .where(
      and(
        eq(workspaceMemberRoles.workspaceId, workspaceId),
        eq(workspaceMemberRoles.memberId, memberId),
      ),
    );
}

/** Every role grant in a workspace, joined to the member roster (the governance read surface). */
export async function listMemberRoles(workspaceId: string): Promise<MemberRoleRow[]> {
  const rows = await db
    .select({
      memberId: workspaceMemberRoles.memberId,
      role: workspaceMemberRoles.role,
      displayName: members.displayName,
      kind: members.kind,
    })
    .from(workspaceMemberRoles)
    .innerJoin(members, eq(members.id, workspaceMemberRoles.memberId))
    .where(eq(workspaceMemberRoles.workspaceId, workspaceId));
  return rows as MemberRoleRow[];
}

/** True iff the workspace already has at least one owner (the bootstrap guard). */
export async function hasAnyOwner(workspaceId: string): Promise<boolean> {
  const [row] = await db
    .select({ memberId: workspaceMemberRoles.memberId })
    .from(workspaceMemberRoles)
    .where(
      and(eq(workspaceMemberRoles.workspaceId, workspaceId), eq(workspaceMemberRoles.role, "owner")),
    )
    .limit(1);
  return row !== undefined;
}

/** How many owners the workspace has right now — the last-owner guard (#151 review fix). */
export async function countOwners(workspaceId: string): Promise<number> {
  const rows = await db
    .select({ memberId: workspaceMemberRoles.memberId })
    .from(workspaceMemberRoles)
    .where(
      and(eq(workspaceMemberRoles.workspaceId, workspaceId), eq(workspaceMemberRoles.role, "owner")),
    );
  return rows.length;
}

/** Create a pending email invite. The raw token is the caller's to share; only its hash is stored. */
export async function createInvite(input: {
  workspaceId: string;
  email: string;
  role: WorkspaceRole;
  tokenHash: string;
  invitedByMemberId: string | null;
}): Promise<InviteRow> {
  const [row] = await db
    .insert(workspaceInvites)
    .values({
      id: newId(),
      workspaceId: input.workspaceId,
      email: input.email,
      role: input.role,
      tokenHash: input.tokenHash,
      status: "pending",
      invitedByMemberId: input.invitedByMemberId,
    })
    .onConflictDoUpdate({
      // Re-inviting the same email re-issues the token + role (the open invite is replaced).
      target: [workspaceInvites.workspaceId, workspaceInvites.email],
      set: {
        role: input.role,
        tokenHash: input.tokenHash,
        status: "pending",
        invitedByMemberId: input.invitedByMemberId,
        acceptedMemberId: null,
        acceptedAt: null,
      },
    })
    .returning();
  return row as InviteRow;
}

/** Look up a pending invite by its token hash (accept path). Returns null if absent/already used. */
export async function getPendingInviteByTokenHash(tokenHash: string): Promise<InviteRow | null> {
  const [row] = await db
    .select()
    .from(workspaceInvites)
    .where(and(eq(workspaceInvites.tokenHash, tokenHash), eq(workspaceInvites.status, "pending")))
    .limit(1);
  return (row as InviteRow | undefined) ?? null;
}

/** Mark an invite accepted by a member (idempotent: only flips a still-pending invite). */
export async function acceptInvite(
  inviteId: string,
  acceptedMemberId: string,
): Promise<InviteRow | null> {
  const [row] = await db
    .update(workspaceInvites)
    .set({ status: "accepted", acceptedMemberId, acceptedAt: new Date() })
    .where(and(eq(workspaceInvites.id, inviteId), eq(workspaceInvites.status, "pending")))
    .returning();
  return (row as InviteRow | undefined) ?? null;
}

/** Revoke a pending invite (owner cancels). */
export async function revokeInvite(workspaceId: string, inviteId: string): Promise<void> {
  await db
    .update(workspaceInvites)
    .set({ status: "revoked" })
    .where(
      and(
        eq(workspaceInvites.workspaceId, workspaceId),
        eq(workspaceInvites.id, inviteId),
        eq(workspaceInvites.status, "pending"),
      ),
    );
}

/** List invites for a workspace (governance read). */
export async function listInvites(workspaceId: string): Promise<InviteRow[]> {
  const rows = await db
    .select()
    .from(workspaceInvites)
    .where(eq(workspaceInvites.workspaceId, workspaceId));
  return rows as InviteRow[];
}
