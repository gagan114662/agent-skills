import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { WorktreePoolService, WorktreePoolExhaustedError } from "../../src/worktree-pool/service.js";

// #575/#394: this suite drives REAL `git` subprocesses + real fs. `npm test` runs all ~580 unit
// files in parallel (default 5s timeout, no config), so under full-suite CPU contention a test that
// shells out to git a dozen times can blow the 5s default and flake. Give it generous, explicit
// headroom so the flakiness is gone without masking a genuine hang (a real wedge still trips at 30s).
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

/**
 * WorktreePoolService (#343, ADR-0343) against a REAL temp git repo — hermetic (no DB, no network).
 * Proves the treehouse claims with real git: warm reuse keeps gitignored deps, concurrent acquire is
 * conflict-free, and destroying a dirty worktree is gated behind force (#200 §4).
 */
let root: string;
let repoRoot: string;
let poolRoot: string;

function git(cwd: string, ...args: string[]): void {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
}

function svc(size: number): WorktreePoolService {
  return new WorktreePoolService({ repoRoot, poolRoot, baseBranch: "main", size });
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "wt-pool-test-"));
  repoRoot = join(root, "repo");
  poolRoot = join(root, "pool");
  mkdirSync(repoRoot, { recursive: true });
  git(repoRoot, "init", "-b", "main");
  git(repoRoot, "config", "user.email", "test@example.com");
  git(repoRoot, "config", "user.name", "Test");
  writeFileSync(join(repoRoot, ".gitignore"), "node_modules/\n");
  writeFileSync(join(repoRoot, "README.md"), "# base\n");
  git(repoRoot, "add", "-A");
  git(repoRoot, "commit", "-m", "init");
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("acquire / grow", () => {
  it("grows a fresh worktree on first acquire (cold — no deps yet)", async () => {
    const pool = svc(2);
    const a = await pool.acquire("s1");
    expect(a.slotId).toBe("slot-0");
    expect(a.warm).toBe(false);
    expect(existsSync(join(a.cwd, "README.md"))).toBe(true);
    expect(existsSync(join(a.cwd, "node_modules"))).toBe(false);
  });

  it("re-acquiring the same session returns the same slot (idempotent, warm)", async () => {
    const pool = svc(2);
    const a = await pool.acquire("s1");
    const b = await pool.acquire("s1");
    expect(b.slotId).toBe(a.slotId);
    expect(b.warm).toBe(true);
  });
});

describe("warm reuse keeps gitignored deps (the whole point)", () => {
  it("node_modules survives release → re-acquire", async () => {
    const pool = svc(1);
    const a = await pool.acquire("s1");
    // simulate `pnpm install`: materialize gitignored deps + an agent edit
    mkdirSync(join(a.cwd, "node_modules", "lib"), { recursive: true });
    writeFileSync(join(a.cwd, "node_modules", "lib", "index.js"), "module.exports = 42;\n");
    writeFileSync(join(a.cwd, "README.md"), "# edited by agent\n");

    await pool.release("s1");

    // a different session reuses the same single slot — warm
    const b = await pool.acquire("s2");
    expect(b.slotId).toBe("slot-0");
    expect(b.warm).toBe(true);
    // deps preserved:
    expect(readFileSync(join(b.cwd, "node_modules", "lib", "index.js"), "utf8")).toContain("42");
    // tracked agent edit reset to base:
    expect(readFileSync(join(b.cwd, "README.md"), "utf8")).toBe("# base\n");
  });

  it("release resets tracked edits and removes untracked non-ignored files, keeps deps", async () => {
    const pool = svc(1);
    const a = await pool.acquire("s1");
    mkdirSync(join(a.cwd, "node_modules"), { recursive: true });
    writeFileSync(join(a.cwd, "node_modules", "keep.txt"), "deps\n");
    writeFileSync(join(a.cwd, "scratch.txt"), "untracked junk\n"); // not ignored → should be cleaned
    writeFileSync(join(a.cwd, "README.md"), "# dirty\n");

    await pool.release("s1");
    const status = await pool.status();
    expect(status[0]?.state).toBe("free");
    expect(status[0]?.dirty).toBe(false);
    expect(existsSync(join(a.cwd, "scratch.txt"))).toBe(false); // untracked cleaned
    expect(existsSync(join(a.cwd, "node_modules", "keep.txt"))).toBe(true); // gitignored kept
  });
});

describe("conflict-free concurrent acquire (#200 §3)", () => {
  it("N concurrent acquires get N distinct worktrees, never the same one", async () => {
    const pool = svc(4);
    const results = await Promise.all([
      pool.acquire("a"),
      pool.acquire("b"),
      pool.acquire("c"),
      pool.acquire("d"),
    ]);
    const paths = results.map((r) => r.cwd);
    const slotIds = results.map((r) => r.slotId);
    expect(new Set(paths).size).toBe(4); // all distinct
    expect(new Set(slotIds).size).toBe(4);
    // every worktree is a real, separate checkout
    for (const r of results) expect(existsSync(join(r.cwd, "README.md"))).toBe(true);
  });

});

describe("queue on exhaustion (#640)", () => {
  // A no-op release whose lease holds nothing — used only to serialize behind pending enqueues
  // (the mutex is FIFO), so we can assert the queued state deterministically without timers.
  const settleQueue = (pool: WorktreePoolService) => pool.release("__ghost__");

  it("queues overflow acquires instead of failing, draining them FIFO as slots free", async () => {
    const pool = svc(1);
    await pool.acquire("s1"); // slot-0 leased — pool now at cap

    const pendingB = pool.acquire("s2");
    const pendingC = pool.acquire("s3");
    await settleQueue(pool); // both s2,s3 have now enqueued (and freed nothing)

    expect(pool.queueDepth()).toBe(2);
    expect(pool.queued().map((q) => q.sessionId)).toEqual(["s2", "s3"]);
    expect(pool.queued().map((q) => q.position)).toEqual([0, 1]);

    // First release drains the head of the line (s2), leaving s3 queued.
    await pool.release("s1");
    const b = await pendingB;
    expect(b.slotId).toBe("slot-0");
    expect(pool.queued().map((q) => q.sessionId)).toEqual(["s3"]);

    // Second release drains s3 — queue empties cleanly.
    await pool.release("s2");
    const c = await pendingC;
    expect(c.slotId).toBe("slot-0");
    expect(pool.queueDepth()).toBe(0);
  });

  it("spawning more agents than capacity queues the overflow and drains cleanly (acceptance)", async () => {
    const pool = svc(2);
    const sessions = ["a", "b", "c", "d", "e"];
    const acquires = sessions.map((s) => pool.acquire(s));
    await settleQueue(pool); // a,b served (grew slot-0/1); c,d,e queued

    expect(pool.queueDepth()).toBe(3);
    expect(pool.queued().map((q) => q.sessionId)).toEqual(["c", "d", "e"]);

    // a,b were served immediately; releasing each drains one queued overflow in FIFO order.
    await pool.release("a");
    expect((await acquires[2]).warm).toBe(true); // c reuses a's freed (warm) slot
    await pool.release("b");
    await acquires[3]; // d
    await pool.release("c");
    await acquires[4]; // e

    expect(pool.queueDepth()).toBe(0);
    const all = await Promise.all(acquires);
    // Every one of the five got a real, materialized worktree — none failed.
    for (const r of all) expect(existsSync(join(r.cwd, "README.md"))).toBe(true);
  });

  it("rejects a queued acquire after timeoutMs without wedging the queue", async () => {
    vi.useFakeTimers();
    try {
      // size 0 disables growth, so the very first acquire is exhausted and queues — no git I/O.
      const pool = svc(0);
      const pending = pool.acquire("s1", { timeoutMs: 1000 });
      pending.catch(() => {}); // pre-attach so the rejection is never "unhandled"
      await settleQueue(pool); // s1 enqueued, timeout armed

      expect(pool.queueDepth()).toBe(1);

      await vi.advanceTimersByTimeAsync(1000);

      await expect(pending).rejects.toBeInstanceOf(WorktreePoolExhaustedError);
      expect(pool.queueDepth()).toBe(0); // timed-out waiter removed — queue not wedged
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("destroy — irreversibility gate (#200 §4)", () => {
  it("REFUSES to destroy a dirty worktree without force", async () => {
    const pool = svc(1);
    const a = await pool.acquire("s1");
    writeFileSync(join(a.cwd, "README.md"), "# uncommitted work\n"); // dirty
    const res = await pool.destroy("slot-0");
    expect(res.destroyed).toBe(false);
    expect(res.destroyed === false && res.reason).toMatch(/force/);
    expect(existsSync(a.cwd)).toBe(true); // still there — work not lost
  });

  it("destroys a dirty worktree WITH force (the human/--force gate)", async () => {
    const pool = svc(1);
    const a = await pool.acquire("s1");
    writeFileSync(join(a.cwd, "README.md"), "# uncommitted\n");
    const res = await pool.destroy("slot-0", { force: true });
    expect(res.destroyed).toBe(true);
    expect(existsSync(a.cwd)).toBe(false);
  });

  it("destroys a clean worktree without force", async () => {
    const pool = svc(1);
    await pool.acquire("s1");
    await pool.release("s1");
    const res = await pool.destroy("slot-0");
    expect(res.destroyed).toBe(true);
  });
});

describe("releaseInactive — stale-lease reaper (#70 keep-set, pool edition)", () => {
  it("returns a crashed session's slot but never a live concurrent one", async () => {
    const pool = svc(2);
    await pool.acquire("live");
    await pool.acquire("crashed");

    const reaped = await pool.releaseInactive(["live"]);
    expect(reaped).toEqual(["crashed"]);

    const status = await pool.status();
    const byLessee = Object.fromEntries(status.map((s) => [s.leasedBy ?? "free", s.state]));
    expect(byLessee.live).toBe("leased"); // live run untouched
    // the crashed slot is now free and reusable
    expect(status.some((s) => s.state === "free")).toBe(true);
  });
});

describe("discover — re-adopt the pool after a restart", () => {
  it("adopts existing pool worktrees from git", async () => {
    const pool = svc(2);
    await pool.acquire("s1");
    await pool.release("s1");

    // a brand-new service instance (simulating a restart) discovers the on-disk slot
    const restarted = svc(2);
    await restarted.discover();
    const status = await restarted.status();
    expect(status.map((s) => s.id)).toContain("slot-0");
    // reuse it warm via the new instance
    const a = await restarted.acquire("s2");
    expect(a.slotId).toBe("slot-0");
    expect(a.warm).toBe(true);
  });
});
