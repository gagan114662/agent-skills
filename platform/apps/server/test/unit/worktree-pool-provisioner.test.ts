import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { GitWorkspaceService } from "../../src/git/workspace.js";
import { CONFIG_DEFAULTS, type ResolvedConfig, type WorktreePoolConfig } from "../../src/config/schema.js";
import {
  maybePooledWorktreeProvisioner,
  PooledWorktreeProvisioner,
} from "../../src/worktree-pool/provisioner.js";
import type { WorkspaceProvisioner } from "../../src/config/workspace.js";

/**
 * PooledWorktreeProvisioner / maybePooledWorktreeProvisioner (#343, ADR-0343). Proves the opt-in path
 * is additive: with the flag OFF (the default) and for every non-owner workspace it is a pure
 * pass-through to the existing provisioner, so today's behavior is unchanged.
 */
let root: string;
let repoRoot: string;
let gitWorkspace: GitWorkspaceService;

function git(cwd: string, ...args: string[]): void {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
}

/** A fallback provisioner that records calls and returns a sentinel cwd. */
function fallbackStub(): { provisioner: WorkspaceProvisioner; calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    provisioner: {
      prepare(input) {
        calls.push(input.sessionId);
        return Promise.resolve({ cwd: `/fallback/${input.sessionId}` });
      },
    },
  };
}

const cfgWith = (worktreePool: WorktreePoolConfig): ResolvedConfig => ({
  ...CONFIG_DEFAULTS,
  worktreePool,
});

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "wt-prov-test-"));
  repoRoot = join(root, "repo");
  mkdirSync(repoRoot, { recursive: true });
  git(repoRoot, "init", "-b", "main");
  git(repoRoot, "config", "user.email", "t@e.com");
  git(repoRoot, "config", "user.name", "T");
  writeFileSync(join(repoRoot, ".gitignore"), "node_modules/\n.reload-worktree-pool/\n");
  writeFileSync(join(repoRoot, "README.md"), "# base\n");
  git(repoRoot, "add", "-A");
  git(repoRoot, "commit", "-m", "init");
  gitWorkspace = new GitWorkspaceService({
    repoRoot,
    worktreesRoot: join(root, "worktrees"),
    baseBranch: "main",
  });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("maybePooledWorktreeProvisioner — composition gate", () => {
  it("returns the fallback UNCHANGED when no git repo is configured", () => {
    const fb = fallbackStub();
    const { provisioner, pool } = maybePooledWorktreeProvisioner({
      fallback: fb.provisioner,
      gitWorkspace: undefined,
      loadConfig: () => cfgWith({ enabled: true, ownerWorkspaceOnly: false }),
    });
    expect(provisioner).toBe(fb.provisioner);
    expect(pool).toBeUndefined();
  });

  it("returns the fallback UNCHANGED when the pool is disabled at the server level (default)", () => {
    const fb = fallbackStub();
    const { provisioner, pool } = maybePooledWorktreeProvisioner({
      fallback: fb.provisioner,
      gitWorkspace,
      loadConfig: () => cfgWith({}), // default OFF
    });
    expect(provisioner).toBe(fb.provisioner);
    expect(pool).toBeUndefined();
  });

  it("wraps with a pool when enabled at the server level", () => {
    const fb = fallbackStub();
    const { provisioner, pool } = maybePooledWorktreeProvisioner({
      fallback: fb.provisioner,
      gitWorkspace,
      loadConfig: () => cfgWith({ enabled: true, ownerWorkspaceOnly: false, size: 2 }),
    });
    expect(provisioner).toBeInstanceOf(PooledWorktreeProvisioner);
    expect(pool).toBeDefined();
  });
});

describe("PooledWorktreeProvisioner — per-workspace opt-in", () => {
  it("delegates to the fallback for a workspace where the pool is OFF", async () => {
    const fb = fallbackStub();
    const { provisioner } = maybePooledWorktreeProvisioner({
      fallback: fb.provisioner,
      gitWorkspace,
      loadConfig: () => cfgWith({ enabled: true, ownerWorkspaceId: "ws_owner", size: 2 }),
    });
    const prepared = await provisioner.prepare({ sessionId: "s1", workspaceId: "ws_other" });
    expect(prepared.cwd).toBe("/fallback/s1"); // owner-first → non-owner takes the existing path
    expect(fb.calls).toEqual(["s1"]);
  });

  it("acquires from the pool for the owner workspace", async () => {
    const fb = fallbackStub();
    const { provisioner } = maybePooledWorktreeProvisioner({
      fallback: fb.provisioner,
      gitWorkspace,
      loadConfig: () => cfgWith({ enabled: true, ownerWorkspaceId: "ws_owner", size: 2 }),
    });
    const prepared = await provisioner.prepare({ sessionId: "s1", workspaceId: "ws_owner" });
    expect(prepared.cwd).toContain(".reload-worktree-pool");
    expect(fb.calls).toEqual([]); // pool served it, fallback untouched
  });

  it("falls back to a fresh checkout when the pool is exhausted", async () => {
    const fb = fallbackStub();
    const { provisioner } = maybePooledWorktreeProvisioner({
      fallback: fb.provisioner,
      gitWorkspace,
      loadConfig: () => cfgWith({ enabled: true, ownerWorkspaceOnly: false, size: 1 }),
    });
    const first = await provisioner.prepare({ sessionId: "s1", workspaceId: "ws" });
    expect(first.cwd).toContain(".reload-worktree-pool");
    // size 1, s1 still leased → s2 exhausts the pool and must fall back
    const second = await provisioner.prepare({ sessionId: "s2", workspaceId: "ws" });
    expect(second.cwd).toBe("/fallback/s2");
    expect(fb.calls).toEqual(["s2"]);
  });
});
