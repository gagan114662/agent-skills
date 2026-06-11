/**
 * Boot backfill for the marketing department fleet (#138). Signup auto-seed (`maybeAutoSeedOnSignup`)
 * only covers workspaces created **after** the fleet was enabled — the owner's workspace (and any other
 * pre-existing tenant) predates it and would land in the old empty shell. On every server boot this
 * sweeps existing workspaces and idempotently ensures each enabled one has its agency (channels +
 * personas), mirroring the one-shot reaper sweep in `index.ts`.
 *
 * Pure + seam-injected so it runs in the no-DB unit job; `marketing/default.ts` binds the real repos.
 * Idempotent (the seeder matches channels by name and personas by handle and posts intros only on
 * creation), never launches welcome sessions (no spend), and best-effort per workspace — one tenant's
 * failure is logged and never stops the rest or crashes startup.
 */

export interface MarketingBackfillDeps {
  /** Every workspace id (the work-list). */
  listWorkspaceIds(): Promise<string[]>;
  /** The member id to attribute the seed to (the workspace's human owner), or undefined if none. */
  ownerMemberId(workspaceId: string): Promise<string | undefined>;
  /** Whether the marketing fleet is enabled for this workspace (resolved layered config). */
  isEnabled(workspaceId: string): boolean;
  /** Ensure the department fleet for a workspace (idempotent, no welcome-session launches). */
  seed(input: { workspaceId: string; createdByMemberId: string }): Promise<void>;
  log: {
    info: (obj: unknown, msg?: string) => void;
    warn: (obj: unknown, msg?: string) => void;
    error: (obj: unknown, msg?: string) => void;
  };
}

export interface MarketingBackfillResult {
  seeded: number;
  skipped: number;
  failed: number;
}

export async function runMarketingBackfill(deps: MarketingBackfillDeps): Promise<MarketingBackfillResult> {
  const result: MarketingBackfillResult = { seeded: 0, skipped: 0, failed: 0 };
  const workspaceIds = await deps.listWorkspaceIds();
  for (const workspaceId of workspaceIds) {
    if (!deps.isEnabled(workspaceId)) {
      result.skipped++;
      continue;
    }
    const createdByMemberId = await deps.ownerMemberId(workspaceId);
    if (!createdByMemberId) {
      deps.log.warn({ workspaceId }, "marketing backfill skipped: workspace has no human owner");
      result.skipped++;
      continue;
    }
    try {
      await deps.seed({ workspaceId, createdByMemberId });
      result.seeded++;
    } catch (err) {
      deps.log.error({ err, workspaceId }, "marketing backfill failed for workspace");
      result.failed++;
    }
  }
  if (result.seeded > 0 || result.failed > 0) {
    deps.log.info(result, "marketing department backfill complete");
  }
  return result;
}
