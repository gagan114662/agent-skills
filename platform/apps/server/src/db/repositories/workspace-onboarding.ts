import { eq } from "drizzle-orm";
import { db } from "../index.js";
import { workspaceOnboarding } from "../schema/index.js";

/**
 * Repo for the #260 onboarding state (the typed domain + the post-signin bootstrap flag). One row per
 * workspace; writes upsert (last write wins). No secret here — the Google tokens live in the #192 vault.
 */

export interface WorkspaceOnboarding {
  domain: string | null;
  bootstrapped: boolean;
  bootstrappedAtMs: number | null;
}

/** Persist the customer's typed domain (idempotent upsert). */
export async function setWorkspaceDomain(workspaceId: string, domain: string): Promise<void> {
  const now = new Date();
  await db
    .insert(workspaceOnboarding)
    .values({ workspaceId, domain, createdAt: now, updatedAt: now })
    .onConflictDoUpdate({
      target: workspaceOnboarding.workspaceId,
      set: { domain, updatedAt: now },
    });
}

/** Mark the workspace's post-signin bootstrap (seed fleet + Scout brief) as done, so re-login won't re-fire it. */
export async function markWorkspaceBootstrapped(workspaceId: string): Promise<void> {
  const now = new Date();
  await db
    .insert(workspaceOnboarding)
    .values({ workspaceId, bootstrappedAt: now, createdAt: now, updatedAt: now })
    .onConflictDoUpdate({
      target: workspaceOnboarding.workspaceId,
      set: { bootstrappedAt: now, updatedAt: now },
    });
}

/** The onboarding state for a workspace, or null when the workspace was never onboarded via #260. */
export async function getWorkspaceOnboarding(
  workspaceId: string,
): Promise<WorkspaceOnboarding | null> {
  const [row] = await db
    .select({
      domain: workspaceOnboarding.domain,
      bootstrappedAt: workspaceOnboarding.bootstrappedAt,
    })
    .from(workspaceOnboarding)
    .where(eq(workspaceOnboarding.workspaceId, workspaceId))
    .limit(1);
  if (!row) return null;
  return {
    domain: row.domain,
    bootstrapped: row.bootstrappedAt !== null,
    bootstrappedAtMs: row.bootstrappedAt ? row.bootstrappedAt.getTime() : null,
  };
}
