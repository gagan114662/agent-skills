import { and, eq, isNull } from "drizzle-orm";
import { db } from "../index.js";
import { cloudWorkspaceCollaborators } from "../schema/index.js";
import type { Capability } from "./permissions.js";

export interface CloudWorkspaceCollaborator {
  id: string;
  cloudWorkspaceId: string;
  memberId: string;
  capability: Capability;
  grantedByMemberId: string | null;
  grantedAt: Date;
  revokedAt: Date | null;
}

const COLUMNS = {
  id: cloudWorkspaceCollaborators.id,
  cloudWorkspaceId: cloudWorkspaceCollaborators.cloudWorkspaceId,
  memberId: cloudWorkspaceCollaborators.memberId,
  capability: cloudWorkspaceCollaborators.capability,
  grantedByMemberId: cloudWorkspaceCollaborators.grantedByMemberId,
  grantedAt: cloudWorkspaceCollaborators.grantedAt,
  revokedAt: cloudWorkspaceCollaborators.revokedAt,
} as const;

/**
 * Invite (or re-invite) a member as a collaborator at `capability`. Upserts on the unique
 * (cloud_workspace_id, member_id) and clears any prior `revoked_at` — re-inviting restores access.
 */
export async function upsertCollaborator(input: {
  cloudWorkspaceId: string;
  memberId: string;
  capability: Capability;
  grantedByMemberId: string;
}): Promise<void> {
  await db
    .insert(cloudWorkspaceCollaborators)
    .values({
      cloudWorkspaceId: input.cloudWorkspaceId,
      memberId: input.memberId,
      capability: input.capability,
      grantedByMemberId: input.grantedByMemberId,
    })
    .onConflictDoUpdate({
      target: [
        cloudWorkspaceCollaborators.cloudWorkspaceId,
        cloudWorkspaceCollaborators.memberId,
      ],
      set: {
        capability: input.capability,
        grantedByMemberId: input.grantedByMemberId,
        grantedAt: new Date(),
        revokedAt: null,
      },
    });
}

/** The member's ACTIVE collaborator grant on a workspace (revoked → undefined), or undefined. */
export async function getActiveCollaborator(
  cloudWorkspaceId: string,
  memberId: string,
): Promise<CloudWorkspaceCollaborator | undefined> {
  const [row] = await db
    .select(COLUMNS)
    .from(cloudWorkspaceCollaborators)
    .where(
      and(
        eq(cloudWorkspaceCollaborators.cloudWorkspaceId, cloudWorkspaceId),
        eq(cloudWorkspaceCollaborators.memberId, memberId),
        isNull(cloudWorkspaceCollaborators.revokedAt),
      ),
    )
    .limit(1);
  return row as CloudWorkspaceCollaborator | undefined;
}

/** Revoke a member's access immediately (sets `revoked_at`; no-op if there is no active grant). */
export async function revokeCollaborator(
  cloudWorkspaceId: string,
  memberId: string,
): Promise<void> {
  await db
    .update(cloudWorkspaceCollaborators)
    .set({ revokedAt: new Date() })
    .where(
      and(
        eq(cloudWorkspaceCollaborators.cloudWorkspaceId, cloudWorkspaceId),
        eq(cloudWorkspaceCollaborators.memberId, memberId),
        isNull(cloudWorkspaceCollaborators.revokedAt),
      ),
    );
}

/** Active collaborators on a workspace (for the roster view). */
export async function listActiveCollaborators(
  cloudWorkspaceId: string,
): Promise<CloudWorkspaceCollaborator[]> {
  const rows = await db
    .select(COLUMNS)
    .from(cloudWorkspaceCollaborators)
    .where(
      and(
        eq(cloudWorkspaceCollaborators.cloudWorkspaceId, cloudWorkspaceId),
        isNull(cloudWorkspaceCollaborators.revokedAt),
      ),
    );
  return rows as CloudWorkspaceCollaborator[];
}

/** Cloud-workspace ids a member actively collaborates on ("shared with me"). */
export async function listCollaboratingWorkspaceIds(memberId: string): Promise<string[]> {
  const rows = await db
    .select({ id: cloudWorkspaceCollaborators.cloudWorkspaceId })
    .from(cloudWorkspaceCollaborators)
    .where(
      and(
        eq(cloudWorkspaceCollaborators.memberId, memberId),
        isNull(cloudWorkspaceCollaborators.revokedAt),
      ),
    );
  return rows.map((r) => r.id);
}
