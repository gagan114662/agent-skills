import { existsSync, mkdirSync, realpathSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { SpawnGitRunner, type GitRunner } from "../git/runner.js";
import {
  decideAcquire,
  decideDestroy,
  decideRelease,
  reapableLeases,
  type PoolConfig,
  type PoolSlot,
} from "./pool.js";

export interface WorktreePoolServiceConfig {
  /** The source repository the pooled worktrees branch off of. */
  repoRoot: string;
  /** Directory the pooled worktrees live under (`<poolRoot>/slot-N`). Distinct from #51's per-session root. */
  poolRoot: string;
  /** The branch every pooled worktree resets to. Default `main`. */
  baseBranch: string;
  /** Hard cap on pool growth (treehouse.toml `pool_size`). */
  size: number;
}

export interface AcquiredWorktree {
  /** The leased worktree's working dir (handed to the runtime as `cwd`). */
  cwd: string;
  /** The pool slot id serving this lease. */
  slotId: string;
  /** True when the slot was reused warm (deps/build cache intact) rather than freshly created. */
  warm: boolean;
}

/** Git identity for any pool-side commit/branch op — kept off the host global config (hermetic). */
const POOL_IDENTITY = ["-c", "user.name=Reload Pool", "-c", "user.email=pool@reload.local"];

/**
 * WorktreePoolService (#343, ADR-0343) — the treehouse worktree pool. Executes the pure {@link
 * ./pool.js} decisions against real git: it keeps a bounded pool of reusable worktrees under
 * `poolRoot`, hands a session a clean-but-warm one on {@link acquire}, and returns it on {@link
 * release} by resetting tracked files to base — gitignored `node_modules`/build cache survive, so the
 * NEXT acquire of that slot is warm (the whole point: no per-session reinstall).
 *
 * Lease state lives in memory (keyed by the **server-issued** sessionId, never a client string); the
 * worktrees themselves are discovered from git on boot ({@link discover}) so a restart re-adopts the
 * pool instead of leaking it. Every git ref is derived from the sessionId or a pool-local slot id, run
 * as argv (no shell — the #50 rule). No daemon, exactly like treehouse.
 *
 * Safety (#200): {@link acquire} never hands out a leased slot (conflict-free concurrent acquire), and
 * {@link destroy} refuses a dirty worktree without `force` (the human/`--force` gate — destroying
 * uncommitted work is irreversible, §4).
 */
export class WorktreePoolService {
  private readonly cfg: WorktreePoolServiceConfig;
  private readonly runner: GitRunner;
  /** slotId → lease holder (a sessionId), present only while leased. */
  private readonly leases = new Map<string, string>();
  /** Every slot id the pool has materialized (free or leased). */
  private readonly known = new Set<string>();
  /** Serializes acquire/release so two concurrent acquires can't both pick the same free slot. */
  private mutex: Promise<void> = Promise.resolve();

  constructor(cfg: WorktreePoolServiceConfig, runner: GitRunner = new SpawnGitRunner()) {
    this.cfg = cfg;
    this.runner = runner;
  }

  private get poolConfig(): PoolConfig {
    return { size: this.cfg.size };
  }

  /** The deterministic worktree path for a slot id. */
  slotPath(slotId: string): string {
    return join(this.cfg.poolRoot, slotId);
  }

  /**
   * Adopt any pool worktrees git already knows about under `poolRoot` (after a restart). Parses
   * `git worktree list --porcelain` and keeps only worktrees whose parent dir is our pool root —
   * compared by basename/dir so the main checkout and the #51 per-session worktrees are never adopted.
   * Adopted slots start `free` (no in-memory lease survives a restart); a stale lease is reconciled by
   * {@link releaseInactive} against the live session set.
   */
  async discover(): Promise<void> {
    if (!existsSync(this.cfg.poolRoot)) return;
    const porcelain = await this.git(this.cfg.repoRoot, ["worktree", "list", "--porcelain"]);
    const rootReal = this.realpath(this.cfg.poolRoot);
    for (const line of porcelain.split("\n")) {
      if (!line.startsWith("worktree ")) continue;
      const path = line.slice("worktree ".length).trim();
      // Compare by realpath so a `/tmp`↔`/private/tmp` symlink can't drop a match (mirrors #70 reaper).
      if (this.realpath(dirname(path)) === rootReal) this.known.add(basename(path));
    }
  }

  /** Snapshot the pool as pure {@link PoolSlot}s (with a fresh `dirty` read) for a decision. */
  private async snapshot(): Promise<PoolSlot[]> {
    const slots: PoolSlot[] = [];
    for (const id of this.known) {
      const path = this.slotPath(id);
      const leasedBy = this.leases.get(id);
      slots.push({
        id,
        path,
        state: leasedBy ? "leased" : "free",
        dirty: await this.isDirty(path),
        leasedBy,
      });
    }
    return slots;
  }

  /**
   * Acquire a warm worktree for `sessionId`. Reuses a free clean slot (warm), resets a free dirty
   * slot then leases it, or grows the pool up to `size`. Throws only when the pool is exhausted (all
   * slots leased and at cap) — the caller falls back to a fresh checkout. Serialized so two concurrent
   * acquires never collide on the same slot.
   */
  acquire(sessionId: string): Promise<AcquiredWorktree> {
    return this.locked(async () => {
      const decision = decideAcquire(await this.snapshot(), sessionId, this.poolConfig);
      switch (decision.kind) {
        case "reuse": {
          return { cwd: decision.slot.path, slotId: decision.slot.id, warm: true };
        }
        case "lease": {
          await this.leaseInto(decision.slot.id, sessionId);
          return { cwd: this.slotPath(decision.slot.id), slotId: decision.slot.id, warm: true };
        }
        case "reset-then-lease": {
          await this.resetSlot(decision.slot.id);
          await this.leaseInto(decision.slot.id, sessionId);
          return { cwd: this.slotPath(decision.slot.id), slotId: decision.slot.id, warm: true };
        }
        case "grow": {
          await this.growSlot(decision.nextId);
          await this.leaseInto(decision.nextId, sessionId);
          // A freshly grown worktree has no deps yet → the one cold spin-up; every reuse after is warm.
          return { cwd: this.slotPath(decision.nextId), slotId: decision.nextId, warm: false };
        }
        case "exhausted": {
          throw new WorktreePoolExhaustedError(this.cfg.size);
        }
      }
    });
  }

  /**
   * Return whatever slot `sessionId` holds: reset tracked files to base (deps survive — gitignored)
   * and mark it free for the next acquire. Idempotent — releasing a session that holds nothing is a
   * no-op. This is the treehouse `return` step; it never destroys, so work is never lost here.
   */
  release(sessionId: string): Promise<void> {
    return this.locked(async () => {
      const decision = decideRelease(await this.snapshot(), sessionId);
      if (decision.kind === "noop") return;
      await this.resetSlot(decision.slot.id);
      this.leases.delete(decision.slot.id);
    });
  }

  /**
   * Reconcile stale leases against the live session set (the #70 keep-set reaper, pool edition):
   * return every slot whose holding session this process is no longer driving, so a crashed run's
   * warm worktree re-enters the pool. A live concurrent run is never reaped (#200 §3). Returns the
   * reaped session ids.
   */
  releaseInactive(activeSessionIds: Iterable<string>): Promise<string[]> {
    return this.locked(async () => {
      const stale = reapableLeases(await this.snapshot(), activeSessionIds);
      for (const sessionId of stale) {
        const decision = decideRelease(this.slotsFromLeases(), sessionId);
        if (decision.kind === "release") {
          await this.resetSlot(decision.slot.id);
          this.leases.delete(decision.slot.id);
        }
      }
      return stale;
    });
  }

  /**
   * Destroy a slot — remove the worktree entirely (pool shrink / corruption recovery). Gated by
   * {@link decideDestroy}: a dirty worktree is refused unless `force` is set, because destroying
   * uncommitted work is irreversible (#200 §4). Returns `{ destroyed: false, reason }` on refusal so
   * the caller surfaces the gate instead of silently dropping work.
   */
  async destroy(
    slotId: string,
    opts: { force?: boolean } = {},
  ): Promise<{ destroyed: true } | { destroyed: false; reason: string }> {
    const path = this.slotPath(slotId);
    const slot: PoolSlot = {
      id: slotId,
      path,
      state: this.leases.has(slotId) ? "leased" : "free",
      dirty: await this.isDirty(path),
      leasedBy: this.leases.get(slotId),
    };
    const gate = decideDestroy(slot, opts);
    if (!gate.allowed) return { destroyed: false, reason: gate.reason };
    await this.tryGit(this.cfg.repoRoot, ["worktree", "remove", "--force", path]);
    await this.tryGit(this.cfg.repoRoot, ["worktree", "prune"]);
    this.leases.delete(slotId);
    this.known.delete(slotId);
    return { destroyed: true };
  }

  /** The current pool state (for `status` / tests / the AGENTS.md `treehouse status` analog). */
  status(): Promise<PoolSlot[]> {
    return this.snapshot();
  }

  // --- internals -------------------------------------------------------------

  /** Build a lease-only snapshot (no dirty read) for the inner reconcile loop in `releaseInactive`. */
  private slotsFromLeases(): PoolSlot[] {
    return [...this.known].map((id) => {
      const leasedBy = this.leases.get(id);
      return { id, path: this.slotPath(id), state: leasedBy ? "leased" : "free", dirty: false, leasedBy };
    });
  }

  /** Create a new pooled worktree (detached HEAD at base — no branch, so no cross-slot branch clash). */
  private async growSlot(slotId: string): Promise<void> {
    mkdirSync(this.cfg.poolRoot, { recursive: true });
    await this.git(this.cfg.repoRoot, [
      "worktree",
      "add",
      "--detach",
      this.slotPath(slotId),
      this.cfg.baseBranch,
    ]);
    this.known.add(slotId);
  }

  /**
   * Lease a slot to a session: create the session's `agent/<sessionId>` branch at base inside the
   * worktree (so the #51 diff/commit/PR flow works unchanged on a pooled worktree), and record the
   * lease. `-B` makes it idempotent if the branch already exists from a prior reuse.
   */
  private async leaseInto(slotId: string, sessionId: string): Promise<void> {
    const path = this.slotPath(slotId);
    await this.git(path, [...POOL_IDENTITY, "checkout", "-B", `agent/${sessionId}`, this.cfg.baseBranch]);
    this.leases.set(slotId, sessionId);
  }

  /**
   * Reset a slot back to a clean base checkout WITHOUT touching gitignored files. Detaches HEAD,
   * deletes any leftover session branch, hard-resets tracked files to base, and removes untracked
   * (non-ignored) files. `git clean -fd` deliberately omits `-x`, so `node_modules`/build cache (which
   * are gitignored) survive — that is what makes the next acquire warm.
   */
  private async resetSlot(slotId: string): Promise<void> {
    const path = this.slotPath(slotId);
    const priorSession = this.leases.get(slotId);
    await this.git(path, [...POOL_IDENTITY, "checkout", "--detach", this.cfg.baseBranch]);
    if (priorSession) await this.tryGit(path, ["branch", "-D", `agent/${priorSession}`]);
    await this.git(path, ["reset", "--hard", this.cfg.baseBranch]);
    await this.git(path, ["clean", "-fd"]); // no -x: gitignored deps/build cache are preserved
  }

  /** True when the worktree has uncommitted tracked changes or untracked NON-ignored files. */
  private async isDirty(path: string): Promise<boolean> {
    if (!existsSync(path)) return false;
    const r = await this.runner.run(["status", "--porcelain"], { cwd: path });
    if (r.code !== 0) return false; // a not-yet-materialized / broken path is treated as not-dirty
    return r.stdout.trim().length > 0;
  }

  /** Serialize an async section against `acquire`/`release`/`releaseInactive` (single-slot safety). */
  private locked<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.mutex.then(fn, fn);
    // Keep the chain alive regardless of this op's outcome so a failure can't wedge the mutex.
    this.mutex = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /** Run git, throwing on a non-zero exit with the captured stderr. Returns stdout. */
  private async git(cwd: string, args: string[]): Promise<string> {
    const r = await this.runner.run(args, { cwd });
    if (r.code !== 0) {
      throw new Error(`git ${args.join(" ")} failed (${r.code}): ${r.stderr.trim()}`);
    }
    return r.stdout;
  }

  /** Resolve symlinks for a stable path compare; falls back to the input when the path doesn't exist. */
  private realpath(p: string): string {
    try {
      return realpathSync(p);
    } catch {
      return p;
    }
  }

  /** Best-effort git: a non-zero exit (or spawn error) is swallowed — used for idempotent cleanup. */
  private async tryGit(cwd: string, args: string[]): Promise<void> {
    try {
      await this.runner.run(args, { cwd });
    } catch {
      /* spawn failure (e.g. cwd gone) — cleanup is best-effort, never fatal */
    }
  }
}

/** Thrown by {@link WorktreePoolService.acquire} when every slot is leased and the pool is at `size`. */
export class WorktreePoolExhaustedError extends Error {
  constructor(readonly size: number) {
    super(`worktree pool exhausted (size ${size}): all slots leased`);
    this.name = "WorktreePoolExhaustedError";
  }
}
