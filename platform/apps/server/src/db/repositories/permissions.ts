import { and, eq } from "drizzle-orm";
import { db } from "../index.js";
import { permissions } from "../schema/index.js";

export type Capability = "read" | "write" | "propagate";

/** The explicit capability granted to a member for a resource, or null if none. */
export async function getCapability(
  workspaceId: string,
  memberId: string,
  resourceType: string,
  resourceId: string,
): Promise<Capability | null> {
  const [row] = await db
    .select({ capability: permissions.capability })
    .from(permissions)
    .where(
      and(
        eq(permissions.workspaceId, workspaceId),
        eq(permissions.memberId, memberId),
        eq(permissions.resourceType, resourceType),
        eq(permissions.resourceId, resourceId),
      ),
    )
    .limit(1);
  return row?.capability ?? null;
}

/** Grant (or upsert) a capability for a member on a resource. Idempotent per the UNIQUE. */
export async function grantCapability(input: {
  workspaceId: string;
  memberId: string;
  resourceType: string;
  resourceId: string;
  capability: Capability;
  grantedByMemberId: string;
}): Promise<void> {
  await db
    .insert(permissions)
    .values({
      workspaceId: input.workspaceId,
      memberId: input.memberId,
      resourceType: input.resourceType,
      resourceId: input.resourceId,
      capability: input.capability,
      grantedByMemberId: input.grantedByMemberId,
    })
    .onConflictDoUpdate({
      target: [
        permissions.workspaceId,
        permissions.memberId,
        permissions.resourceType,
        permissions.resourceId,
      ],
      set: { capability: input.capability, grantedByMemberId: input.grantedByMemberId },
    });
}

/** Revoke a member's explicit grant on a resource (no-op if none). Effect is immediate. */
export async function revokeCapability(
  workspaceId: string,
  memberId: string,
  resourceType: string,
  resourceId: string,
): Promise<void> {
  await db
    .delete(permissions)
    .where(
      and(
        eq(permissions.workspaceId, workspaceId),
        eq(permissions.memberId, memberId),
        eq(permissions.resourceType, resourceType),
        eq(permissions.resourceId, resourceId),
      ),
    );
}

/** All explicit grants on a channel, for the registry/roster view. */
export async function listResourceGrants(
  workspaceId: string,
  resourceType: string,
  resourceId: string,
): Promise<{ memberId: string; capability: Capability }[]> {
  return db
    .select({ memberId: permissions.memberId, capability: permissions.capability })
    .from(permissions)
    .where(
      and(
        eq(permissions.workspaceId, workspaceId),
        eq(permissions.resourceType, resourceType),
        eq(permissions.resourceId, resourceId),
      ),
    );
}
