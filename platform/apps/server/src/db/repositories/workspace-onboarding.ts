import { eq } from "drizzle-orm";
import { db } from "../index.js";
import { workspaceOnboarding } from "../schema/index.js";

/**
 * Repo for the #260 onboarding state (the typed domain + the post-signin bootstrap flag). One row per
 * workspace; writes upsert (last write wins). No secret here — the Google tokens live in the #192 vault.
 */

export interface WorkspaceOnboarding {
  domain: string | null;
  /** Owner-typed product context (#320), surfaced to briefed agents as DATA; null until captured. */
  productContext: string | null;
  /** Structured marketing target (#502): the product/app name the fleet is marketing; null until set. */
  targetName: string | null;
  /** One-line positioning for the target (#502); null until set. */
  targetPositioning: string | null;
  /** The target customer / ICP (#502); null until set. */
  targetAudience: string | null;
  /** The target's competitors (#502); null until set. */
  targetCompetitors: string | null;
  bootstrapped: boolean;
  bootstrappedAtMs: number | null;
}

/** The owner-typed marketing-target fields written by the #502 "What are we marketing?" flow. */
export interface MarketingTargetInput {
  /** The target's website / app URL, stored as the onboarding `domain` (reused by the #250 resolver). */
  domain?: string;
  name?: string;
  positioning?: string;
  audience?: string;
  competitors?: string;
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

/**
 * Persist the workspace's product context (#320, idempotent upsert). Owner-typed free text — the read
 * seam (`marketing/workspace-context.ts`) sanitizes + bounds it before it ever reaches an agent prompt.
 */
export async function setWorkspaceProductContext(
  workspaceId: string,
  productContext: string,
): Promise<void> {
  const now = new Date();
  await db
    .insert(workspaceOnboarding)
    .values({ workspaceId, productContext, createdAt: now, updatedAt: now })
    .onConflictDoUpdate({
      target: workspaceOnboarding.workspaceId,
      set: { productContext, updatedAt: now },
    });
}

/**
 * Persist the structured marketing target (#502, idempotent upsert). Only the provided fields are written
 * (last write wins per field); the target's URL is stored as `domain` so the existing #250 site resolver +
 * #363 crawler keep pointing at the chosen product. Owner-typed values — sanitized + bounded at the read
 * seam (`marketing/workspace-context.ts`) before any agent ever sees them (never run as instructions).
 */
export async function setMarketingTarget(
  workspaceId: string,
  target: MarketingTargetInput,
): Promise<void> {
  const now = new Date();
  const fields = {
    ...(target.domain !== undefined ? { domain: target.domain } : {}),
    ...(target.name !== undefined ? { targetName: target.name } : {}),
    ...(target.positioning !== undefined ? { targetPositioning: target.positioning } : {}),
    ...(target.audience !== undefined ? { targetAudience: target.audience } : {}),
    ...(target.competitors !== undefined ? { targetCompetitors: target.competitors } : {}),
  };
  await db
    .insert(workspaceOnboarding)
    .values({ workspaceId, ...fields, createdAt: now, updatedAt: now })
    .onConflictDoUpdate({
      target: workspaceOnboarding.workspaceId,
      set: { ...fields, updatedAt: now },
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
      productContext: workspaceOnboarding.productContext,
      targetName: workspaceOnboarding.targetName,
      targetPositioning: workspaceOnboarding.targetPositioning,
      targetAudience: workspaceOnboarding.targetAudience,
      targetCompetitors: workspaceOnboarding.targetCompetitors,
      bootstrappedAt: workspaceOnboarding.bootstrappedAt,
    })
    .from(workspaceOnboarding)
    .where(eq(workspaceOnboarding.workspaceId, workspaceId))
    .limit(1);
  if (!row) return null;
  return {
    domain: row.domain,
    productContext: row.productContext,
    targetName: row.targetName,
    targetPositioning: row.targetPositioning,
    targetAudience: row.targetAudience,
    targetCompetitors: row.targetCompetitors,
    bootstrapped: row.bootstrappedAt !== null,
    bootstrappedAtMs: row.bootstrappedAt ? row.bootstrappedAt.getTime() : null,
  };
}
