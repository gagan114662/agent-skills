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
 * A read view over per-session lease heartbeats (#641). A session that holds a worktree heartbeats
 * while it works; the reaper treats a heartbeat within the TTL as an ACTIVE LEASE and refuses to reap
 * that worktree — even if the session has not (yet) shown up in {@link ActiveSessions.activeSessionIds}.
 * That closes the race where a freshly-spawned run's worktree is reaped out from under it.
 */
export interface LeaseHeartbeats {
  /** Session ids whose most recent heartbeat is within `ttlMs` of `now` (i.e. live leases). */
  activeWithin(now: number, ttlMs: number): string[];
}

/** Default lease TTL: a worktree heartbeated within this window is considered in use (#641). */
export const DEFAULT_LEASE_TTL_MS = 60_000;

/**
 * In-memory lease/heartbeat registry (#641). A worktree owner calls {@link touch} on acquire and then
 * periodically while it runs, {@link forget} on release. The reaper reads {@link activeWithin} to keep
 * any worktree with a fresh heartbeat. Lives in this process only — on a cold restart it is empty, so a
 * crashed run's leftover worktree (which can no longer heartbeat) correctly becomes reapable.
 */
export class LeaseRegistry implements LeaseHeartbeats {
  /** sessionId → epoch ms of its last heartbeat. */
  private readonly beats = new Map<string, number>();

  /** Record a heartbeat for `sessionId` at `now` (call on acquire and on each keep-alive tick). */
  touch(sessionId: string, now: number): void {
    this.beats.set(sessionId, now);
  }

  /** Drop a session's lease (call on release/teardown) so its worktree is no longer kept. */
  forget(sessionId: string): void {
    this.beats.delete(sessionId);
  }

  /** Epoch ms of the session's last heartbeat, or `undefined` if it never heartbeated. */
  lastHeartbeat(sessionId: string): number | undefined {
    return this.beats.get(sessionId);
  }

  activeWithin(now: number, ttlMs: number): string[] {
    const ids: string[] = [];
    for (const [id, beat] of this.beats) {
      if (now - beat <= ttlMs) ids.push(id);
    }
    return ids;
  }
}

/** Reaper safety knobs (#641) — inject a lease source + TTL so a live lease is never reaped. */
export interface ReaperOptions {
  /** Lease/heartbeat source. When omitted the reaper falls back to the keep-set only (legacy #70). */
  readonly leases?: LeaseHeartbeats;
  /** A heartbeat within this many ms counts as an active lease. Defaults to {@link DEFAULT_LEASE_TTL_MS}. */
  readonly ttlMs?: number;
  /** Injectable clock (defaults to wall time) — keeps TTL logic deterministic under test. */
  readonly now?: () => number;
}

/**
 * GitWorktreeReaper (#70) — the local analog of the cloud teardown: it reaps every per-session git
 * worktree under `worktreesRoot` whose session this process is no longer driving, bringing local
 * execution to Conductor parity (no isolation unit survives a teardown/restart un-reaped).
 *
 * `index.ts` runs one `sweep()` on boot — on a cold start nothing is live, so every worktree a crashed
 * run left behind is cleaned — and, when `GIT_WORKTREE_REAP_INTERVAL_MS > 0`, on a periodic timer.
 * The keep-set is `SessionManager.activeSessionIds` UNION every session with an active lease heartbeat
 * (#641): a worktree is reaped only when it is both absent from the keep-set AND has no heartbeat
 * within the TTL. That double check means a freshly-spawned run whose session hasn't propagated into
 * `activeSessionIds` yet — but is already heartbeating — is never reaped out from under itself.
 *
 * `sweep()` never throws: a git failure is logged, not propagated, so a sweep can never crash startup.
 */
export class GitWorktreeReaper {
  constructor(
    private readonly git: GitWorkspaceService,
    private readonly sessions: ActiveSessions,
    private readonly logger?: ReaperLogger,
    private readonly opts: ReaperOptions = {},
  ) {}

  async sweep(): Promise<{ reaped: string[] }> {
    try {
      const reaped = await this.git.reapOrphans(this.keepSet());
      if (reaped.length > 0) {
        this.logger?.info({ reaped, count: reaped.length }, "git worktree reaper: swept orphans");
      }
      return { reaped };
    } catch (err) {
      this.logger?.error({ err }, "git worktree reaper: sweep failed");
      return { reaped: [] };
    }
  }

  /**
   * The set of sessions whose worktrees must be kept: the process's active sessions plus any session
   * holding an active lease (heartbeat within the TTL). A worktree is reapable only if it is in
   * NEITHER — i.e. genuinely orphaned: not driven by this process and not heartbeating (#641).
   */
  private keepSet(): string[] {
    const keep = new Set(this.sessions.activeSessionIds);
    if (this.opts.leases) {
      const now = (this.opts.now ?? Date.now)();
      const ttlMs = this.opts.ttlMs ?? DEFAULT_LEASE_TTL_MS;
      for (const id of this.opts.leases.activeWithin(now, ttlMs)) keep.add(id);
    }
    return [...keep];
  }
}
