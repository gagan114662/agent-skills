import { join } from "node:path";
import type {
  PreparedWorkspace,
  WorkspacePrepareInput,
  WorkspaceProvisioner,
} from "../config/workspace.js";
import type { ResolvedConfig } from "../config/schema.js";
import type { GitWorkspaceService } from "../git/workspace.js";
import {
  isWorktreePoolEnabledForWorkspace,
  resolveWorktreePoolCaps,
  type WorktreePoolCaps,
} from "./caps.js";
import { WorktreePoolService } from "./service.js";

/** Optional structural logger (Fastify's `app.log` satisfies it). */
export interface PoolProvisionerLogger {
  info(obj: unknown, msg?: string): void;
  warn(obj: unknown, msg?: string): void;
}

/**
 * How long a launch waits in the pool's queue for a warm slot before falling back to a fresh checkout
 * (#640). Overflow runs WAIT (bounded concurrency, visible 'queued' state) instead of immediately
 * spawning an unbounded fresh checkout; the bound is the safety valve so a launch can never hang on a
 * wedged pool. `0` restores the old fail-fast fallback.
 */
export const DEFAULT_ACQUIRE_QUEUE_TIMEOUT_MS = 30_000;

export interface PooledWorktreeProvisionerDeps {
  /** The provisioner to fall back to when the pool is off for a workspace, the wait times out, or it errors. */
  fallback: WorkspaceProvisioner;
  /** The warm pool. */
  pool: WorktreePoolService;
  /** Resolve the per-tenant config so the owner-first gate is evaluated per workspace. */
  loadConfig: (workspaceId: string) => ResolvedConfig;
  /** Max ms to wait queued for a warm slot before falling back. Defaults to {@link DEFAULT_ACQUIRE_QUEUE_TIMEOUT_MS}. */
  acquireTimeoutMs?: number;
  logger?: PoolProvisionerLogger;
}

/**
 * PooledWorktreeProvisioner (#343, ADR-0343) — the **opt-in** acquire path. On launch, if the warm
 * pool is enabled for the session's workspace (default OFF, owner-workspace-first), it leases a warm
 * worktree from the {@link WorktreePoolService} and hands its `cwd` to the SessionManager. Otherwise —
 * and on any pool failure (exhausted / git error) — it delegates to the `fallback` provisioner, so the
 * existing per-session checkout path is preserved byte-for-byte (additive only, never a regression).
 *
 * This is a thin decorator over the existing seam: with the flag off (the default for every workspace)
 * it is a pure pass-through to `fallback`, so today's behavior is unchanged until the owner opts in.
 */
export class PooledWorktreeProvisioner implements WorkspaceProvisioner {
  constructor(private readonly deps: PooledWorktreeProvisionerDeps) {}

  async prepare(input: WorkspacePrepareInput): Promise<PreparedWorkspace> {
    const caps = resolveWorktreePoolCaps(this.deps.loadConfig(input.workspaceId).worktreePool);
    if (!isWorktreePoolEnabledForWorkspace(caps, input.workspaceId)) {
      return this.deps.fallback.prepare(input);
    }
    const timeoutMs = this.deps.acquireTimeoutMs ?? DEFAULT_ACQUIRE_QUEUE_TIMEOUT_MS;
    try {
      // When the pool is exhausted this WAITS in the queue (#640) — overflow runs get a warm slot as
      // soon as one frees, bounded by `timeoutMs` so a launch never hangs on a wedged pool.
      const acquired = await this.deps.pool.acquire(input.sessionId, { timeoutMs });
      this.deps.logger?.info(
        { sessionId: input.sessionId, slotId: acquired.slotId, warm: acquired.warm },
        "worktree pool: leased warm worktree",
      );
      return { cwd: acquired.cwd };
    } catch (err) {
      // Wait timed out (pool stayed full) or a git hiccup — never block a launch, fall back to a fresh checkout.
      this.deps.logger?.warn(
        { sessionId: input.sessionId, err: err instanceof Error ? err.message : String(err) },
        "worktree pool: acquire failed, falling back to fresh checkout",
      );
      return this.deps.fallback.prepare(input);
    }
  }
}

/**
 * Compose the opt-in pool in front of the existing provisioner (#343). Returns the `fallback`
 * UNCHANGED unless a git repo is configured AND the pool is enabled at the server level — so a
 * deployment that sets nothing gets exactly today's provisioner (zero overhead, zero behavior change).
 * Even when wrapped, the per-workspace owner-first gate inside {@link PooledWorktreeProvisioner}
 * decides each launch, so non-owner workspaces still take the fresh-checkout path.
 *
 * The pool worktrees live under `<repo>/.reload-worktree-pool` — a DIFFERENT root from the #51
 * per-session `.reload-worktrees`, so the #70 reaper (which only matches the per-session root) can
 * never see or destroy a pool slot.
 */
export function maybePooledWorktreeProvisioner(deps: {
  fallback: WorkspaceProvisioner;
  gitWorkspace: GitWorkspaceService | undefined;
  loadConfig: (workspaceId?: string) => ResolvedConfig;
  /** Override the queue-wait bound before falling back (see {@link DEFAULT_ACQUIRE_QUEUE_TIMEOUT_MS}). */
  acquireTimeoutMs?: number;
  logger?: PoolProvisionerLogger;
}): { provisioner: WorkspaceProvisioner; pool?: WorktreePoolService } {
  const { fallback, gitWorkspace, loadConfig, acquireTimeoutMs, logger } = deps;
  if (!gitWorkspace) return { provisioner: fallback };
  const serverCaps: WorktreePoolCaps = resolveWorktreePoolCaps(loadConfig().worktreePool);
  if (!serverCaps.enabled || serverCaps.size <= 0) return { provisioner: fallback };

  const pool = new WorktreePoolService({
    repoRoot: gitWorkspace.repoRoot,
    poolRoot: join(gitWorkspace.repoRoot, ".reload-worktree-pool"),
    baseBranch: gitWorkspace.baseBranch,
    size: serverCaps.size,
  });
  const provisioner = new PooledWorktreeProvisioner({
    fallback,
    pool,
    loadConfig: (workspaceId: string) => loadConfig(workspaceId),
    acquireTimeoutMs,
    logger,
  });
  return { provisioner, pool };
}
