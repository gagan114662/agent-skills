import type { GitWorkspaceService } from "./workspace.js";

/** The slice of SessionManager the reaper needs: which sessions this process is still driving. */
export interface ActiveSessions {
  readonly activeSessionIds: string[];
}

/** Optional structural logger (Fastify's `app.log` satisfies it); the reaper logs what it swept. */
export interface ReaperLogger {
  info(obj: unknown, msg?: string): void;
  error(obj: unknown, msg?: string): void;
}

/**
 * GitWorktreeReaper (#70) — the local analog of the cloud teardown: it reaps every per-session git
 * worktree under `worktreesRoot` whose session this process is no longer driving, bringing local
 * execution to Conductor parity (no isolation unit survives a teardown/restart un-reaped).
 *
 * `index.ts` runs one `sweep()` on boot — on a cold start nothing is live, so every worktree a crashed
 * run left behind is cleaned — and, when `GIT_WORKTREE_REAP_INTERVAL_MS > 0`, on a periodic timer.
 * The keep-set is `SessionManager.activeSessionIds`, so a live concurrent run is never reaped.
 *
 * `sweep()` never throws: a git failure is logged, not propagated, so a sweep can never crash startup.
 */
export class GitWorktreeReaper {
  constructor(
    private readonly git: GitWorkspaceService,
    private readonly sessions: ActiveSessions,
    private readonly logger?: ReaperLogger,
  ) {}

  async sweep(): Promise<{ reaped: string[] }> {
    try {
      const reaped = await this.git.reapOrphans(this.sessions.activeSessionIds);
      if (reaped.length > 0) {
        this.logger?.info({ reaped, count: reaped.length }, "git worktree reaper: swept orphans");
      }
      return { reaped };
    } catch (err) {
      this.logger?.error({ err }, "git worktree reaper: sweep failed");
      return { reaped: [] };
    }
  }
}
