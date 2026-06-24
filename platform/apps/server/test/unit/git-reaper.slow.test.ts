import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { GitWorkspaceService } from "../../src/git/workspace.js";
import { GitWorktreeReaper, LeaseRegistry } from "../../src/git/reaper.js";

// #575/#394: this suite drives REAL git subprocesses + real fs. It lives in the explicit slow lane
// (pnpm test:slow), which runs these git-heavy files serially with 120s headroom under CI load.
vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

/**
 * #70 local worktree isolation — the reaping half. Exercised against a REAL temp git repo (git is on
 * the dev/CI host, no network, no DB). Proves a session's worktree+branch can be reaped, that the
 * reaper only ever touches worktrees under `worktreesRoot`, and that a crash leftover is fully cleaned
 * by a fresh-process orphan sweep — Conductor parity for local execution.
 */
let root: string;
let repoRoot: string;
let worktreesRoot: string;

function git(cwd: string, ...args: string[]): string {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
  return r.stdout;
}

function service(): GitWorkspaceService {
  return new GitWorkspaceService({ repoRoot, worktreesRoot, baseBranch: "main" });
}

/** Branch names currently in the repo (without the `refs/heads/` prefix). */
function branches(): string[] {
  return git(repoRoot, "branch", "--format=%(refname:short)")
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Worktree paths currently registered with git. */
function worktreePaths(): string[] {
  return git(repoRoot, "worktree", "list", "--porcelain")
    .split("\n")
    .filter((l) => l.startsWith("worktree "))
    .map((l) => l.slice("worktree ".length));
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "git-reaper-test-"));
  repoRoot = join(root, "repo");
  worktreesRoot = join(root, "worktrees");
  mkdirSync(repoRoot, { recursive: true });
  git(repoRoot, "init", "-b", "main");
  git(repoRoot, "config", "user.email", "test@example.com");
  git(repoRoot, "config", "user.name", "Test");
  writeFileSync(join(repoRoot, "README.md"), "# base\n");
  git(repoRoot, "add", "-A");
  git(repoRoot, "commit", "-m", "init");
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("GitWorkspaceService.listSessionWorktrees", () => {
  it("returns only session ids under worktreesRoot (never the main checkout)", async () => {
    const svc = service();
    await svc.prepare("sessA");
    await svc.prepare("sessB");
    expect((await svc.listSessionWorktrees()).sort()).toEqual(["sessA", "sessB"]);
  });

  it("is empty before any worktree is prepared", async () => {
    expect(await service().listSessionWorktrees()).toEqual([]);
  });
});

describe("GitWorkspaceService.reapSession", () => {
  it("removes the session's worktree and its agent/<id> branch", async () => {
    const svc = service();
    const { cwd } = await svc.prepare("sessReap");
    expect(existsSync(cwd)).toBe(true);
    expect(branches()).toContain("agent/sessReap");

    await svc.reapSession("sessReap");

    expect(existsSync(cwd)).toBe(false);
    expect(branches()).not.toContain("agent/sessReap");
    expect(worktreePaths()).not.toContain(cwd);
  });

  it("is idempotent — reaping an already-reaped (or never-prepared) session never throws", async () => {
    const svc = service();
    await svc.prepare("sessOnce");
    await svc.reapSession("sessOnce");
    await expect(svc.reapSession("sessOnce")).resolves.toBeUndefined();
    await expect(svc.reapSession("never-existed")).resolves.toBeUndefined();
  });

  it("isolates sessions — reaping A leaves B's worktree and branch intact", async () => {
    const svc = service();
    const a = await svc.prepare("sessA");
    const b = await svc.prepare("sessB");

    await svc.reapSession("sessA");

    expect(existsSync(a.cwd)).toBe(false);
    expect(existsSync(b.cwd)).toBe(true);
    expect(branches()).not.toContain("agent/sessA");
    expect(branches()).toContain("agent/sessB");
  });

  it("keeps the branch when deleteBranch is false", async () => {
    const svc = service();
    const { cwd } = await svc.prepare("sessKeepBranch");
    await svc.reapSession("sessKeepBranch", { deleteBranch: false });
    expect(existsSync(cwd)).toBe(false);
    expect(branches()).toContain("agent/sessKeepBranch");
  });
});

describe("GitWorkspaceService.reapOrphans", () => {
  it("reaps every session worktree not in the keep set and returns the reaped ids", async () => {
    const svc = service();
    const a = await svc.prepare("sessA");
    const b = await svc.prepare("sessB");

    const reaped = await svc.reapOrphans(["sessB"]);

    expect(reaped).toEqual(["sessA"]);
    expect(existsSync(a.cwd)).toBe(false);
    expect(existsSync(b.cwd)).toBe(true);
    expect(branches()).not.toContain("agent/sessA");
    expect(branches()).toContain("agent/sessB");
  });

  it("leaves no orphans after a crash/restart (fresh process, empty keep set)", async () => {
    // First "process": prepare two sessions, then a crash deletes one worktree dir behind git's back.
    const first = service();
    await first.prepare("sessCrash1");
    const c2 = await first.prepare("sessCrash2");
    rmSync(c2.cwd, { recursive: true, force: true }); // crash: dir gone, git still registers it

    // Fresh "process": a brand-new service (no in-memory state) sweeps with nothing live.
    const fresh = service();
    const reaped = await fresh.reapOrphans([]);

    expect(reaped.sort()).toEqual(["sessCrash1", "sessCrash2"]);
    // Only the main checkout remains; no agent/* branches survive. (git prints realpaths.)
    expect(worktreePaths()).toEqual([realpathSync(repoRoot)]);
    expect(branches().filter((b) => b.startsWith("agent/"))).toEqual([]);
  });
});

describe("GitWorktreeReaper.sweep", () => {
  it("reaps orphans while keeping the SessionManager's active sessions", async () => {
    const svc = service();
    const live = await svc.prepare("sessLive");
    const dead = await svc.prepare("sessDead");

    const reaper = new GitWorktreeReaper(svc, { activeSessionIds: ["sessLive"] });
    const result = await reaper.sweep();

    expect(result.reaped).toEqual(["sessDead"]);
    expect(existsSync(live.cwd)).toBe(true);
    expect(existsSync(dead.cwd)).toBe(false);
  });

  it("never throws — a sweep failure is swallowed so startup can't crash", async () => {
    // A service pointed at a non-existent repo makes git fail; sweep must still resolve.
    const broken = new GitWorkspaceService({
      repoRoot: join(root, "does-not-exist"),
      worktreesRoot,
      baseBranch: "main",
    });
    const reaper = new GitWorktreeReaper(broken, { activeSessionIds: [] });
    await expect(reaper.sweep()).resolves.toEqual({ reaped: [] });
  });
});

describe("GitWorktreeReaper lease/heartbeat safety (#641)", () => {
  it("never reaps a worktree with an active lease, even when it's absent from activeSessionIds", async () => {
    // The #641 race: a freshly-spawned run holds a worktree + heartbeats, but hasn't yet propagated
    // into SessionManager.activeSessionIds. Keep-set alone would reap it; the lease check must not.
    const svc = service();
    const live = await svc.prepare("sessLive");
    const dead = await svc.prepare("sessDead");

    const leases = new LeaseRegistry();
    const NOW = 1_000_000;
    leases.touch("sessLive", NOW); // fresh heartbeat — an active lease

    const reaper = new GitWorktreeReaper(svc, { activeSessionIds: [] }, undefined, {
      leases,
      ttlMs: 60_000,
      now: () => NOW,
    });
    const result = await reaper.sweep();

    expect(result.reaped).toEqual(["sessDead"]); // only the genuinely orphaned worktree
    expect(existsSync(live.cwd)).toBe(true); // active lease survived despite empty keep-set
    expect(existsSync(dead.cwd)).toBe(false);
  });

  it("reaps a worktree whose lease heartbeat is older than the TTL (presumed dead)", async () => {
    const svc = service();
    const stale = await svc.prepare("sessStale");

    const leases = new LeaseRegistry();
    const NOW = 1_000_000;
    leases.touch("sessStale", NOW - 120_000); // 2 min old, past the 60s TTL → no active lease

    const reaper = new GitWorktreeReaper(svc, { activeSessionIds: [] }, undefined, {
      leases,
      ttlMs: 60_000,
      now: () => NOW,
    });
    const result = await reaper.sweep();

    expect(result.reaped).toEqual(["sessStale"]);
    expect(existsSync(stale.cwd)).toBe(false);
  });

  it("keeps a session that is BOTH active and leased, reaping only the unprotected one", async () => {
    const svc = service();
    const active = await svc.prepare("sessActive");
    const leased = await svc.prepare("sessLeased");
    const orphan = await svc.prepare("sessOrphan");

    const leases = new LeaseRegistry();
    const NOW = 2_000_000;
    leases.touch("sessLeased", NOW);

    const reaper = new GitWorktreeReaper(svc, { activeSessionIds: ["sessActive"] }, undefined, {
      leases,
      ttlMs: 60_000,
      now: () => NOW,
    });
    const result = await reaper.sweep();

    expect(result.reaped).toEqual(["sessOrphan"]);
    expect(existsSync(active.cwd)).toBe(true);
    expect(existsSync(leased.cwd)).toBe(true);
    expect(existsSync(orphan.cwd)).toBe(false);
  });
});

describe("LeaseRegistry", () => {
  it("reports only sessions heartbeated within the TTL and forgets on release", () => {
    const r = new LeaseRegistry();
    r.touch("a", 0); // at now=1000, age 1000 > ttl 600 → stale
    r.touch("b", 500); // at now=1000, age 500 <= ttl 600 → active

    expect(r.activeWithin(1000, 600)).toEqual(["b"]);
    expect(r.lastHeartbeat("a")).toBe(0);
    expect(r.lastHeartbeat("missing")).toBeUndefined();

    r.touch("a", 900); // re-heartbeat → now active (age 100)
    expect(r.activeWithin(1000, 600).sort()).toEqual(["a", "b"]);

    r.forget("b");
    expect(r.activeWithin(1000, 600)).toEqual(["a"]);
  });
});
