import type { WorktreePoolConfig } from "../config/schema.js";

/**
 * Worktree-pool caps (#343, ADR-0343) — pure policy for whether a fleet session is provisioned from
 * the warm worktree pool (treehouse model) instead of a fresh per-session checkout. Mirrors
 * `subagents/collaboration.ts` / `agent-registry/caps.ts`: a two-pronged gate that is **default OFF**
 * and **owner-workspace-first**, resolved with hard defaults from the layered config.
 *
 * The pool is a spin-up optimization with a real isolation surface (shared `node_modules`/build cache
 * across reuses), so it ships OFF and dogfoods on the owner's own workspace first — a deployment that
 * sets nothing keeps today's per-session checkout exactly, so behavior is unchanged (#200 §3/§4).
 */
export interface WorktreePoolCaps {
  /** Acquire sessions from the warm pool instead of a fresh checkout. OFF by default. */
  enabled: boolean;
  /**
   * Roll the pool out owner-workspace-first (default true): even when `enabled`, an
   * `ownerWorkspaceOnly` deployment only pools `ownerWorkspaceId`; every other tenant keeps today's
   * fresh-checkout path. Set false to pool all tenants once the owner has proven the path.
   */
  ownerWorkspaceOnly: boolean;
  /** The owner's own workspace id — the pool dogfoods here first. */
  ownerWorkspaceId: string | undefined;
  /** Max worktrees the pool may hold (hard cap on growth). Default 4. */
  size: number;
}

export const WORKTREE_POOL_DEFAULTS: WorktreePoolCaps = {
  enabled: false,
  ownerWorkspaceOnly: true,
  ownerWorkspaceId: undefined,
  size: 4,
};

/** Resolve the worktree-pool caps from the layered config, applying hard defaults. */
export function resolveWorktreePoolCaps(cfg: WorktreePoolConfig | undefined): WorktreePoolCaps {
  return {
    enabled: cfg?.enabled ?? WORKTREE_POOL_DEFAULTS.enabled,
    ownerWorkspaceOnly: cfg?.ownerWorkspaceOnly ?? WORKTREE_POOL_DEFAULTS.ownerWorkspaceOnly,
    ownerWorkspaceId: cfg?.ownerWorkspaceId ?? WORKTREE_POOL_DEFAULTS.ownerWorkspaceId,
    size: cfg?.size ?? WORKTREE_POOL_DEFAULTS.size,
  };
}

/**
 * Pure: is the warm pool ENABLED for this specific workspace (#343)? The capability rolls out
 * owner-workspace-first — so even when the master `enabled` flag is on, an `ownerWorkspaceOnly`
 * deployment (the default) only pools the named owner workspace, and every other tenant keeps today's
 * fresh-checkout path. Turning `enabled` on WITHOUT naming the owner workspace pools nobody (the
 * safest default, matching `agentRegistry`/`agentCollaboration`/`venture`). Set `ownerWorkspaceOnly`
 * false for all.
 */
export function isWorktreePoolEnabledForWorkspace(
  caps: WorktreePoolCaps,
  workspaceId: string,
): boolean {
  if (!caps.enabled) return false;
  if (caps.size <= 0) return false;
  if (!caps.ownerWorkspaceOnly) return true;
  return caps.ownerWorkspaceId !== undefined && caps.ownerWorkspaceId === workspaceId;
}
