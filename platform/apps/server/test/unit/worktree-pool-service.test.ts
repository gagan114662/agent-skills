import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { WorktreePoolService, WorktreePoolExhaustedError } from "../../src/worktree-pool/service.js";

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

  it("throws WorktreePoolExhaustedError when all slots are leased and at cap", async () => {
    const pool = svc(1);
    await pool.acquire("s1");
    await expect(pool.acquire("s2")).rejects.toBeInstanceOf(WorktreePoolExhaustedError);
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
