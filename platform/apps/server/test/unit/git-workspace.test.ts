import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { GitWorkspaceService } from "../../src/git/workspace.js";

/**
 * GitWorkspaceService (#51) against a REAL temp git repo — hermetic (no DB, no network, git is on
 * the dev/CI host). It proves the worktree/branch lifecycle and the cumulative-vs-turn diff that the
 * review surface renders. Branch names derive only from the server-issued sessionId, so no client
 * string ever reaches a git ref.
 */
let root: string;
let repoRoot: string;
let svc: GitWorkspaceService;

function git(cwd: string, ...args: string[]): void {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "git-ws-test-"));
  repoRoot = join(root, "repo");
  mkdirSync(repoRoot, { recursive: true });
  git(repoRoot, "init", "-b", "main");
  git(repoRoot, "config", "user.email", "test@example.com");
  git(repoRoot, "config", "user.name", "Test");
  writeFileSync(join(repoRoot, "README.md"), "# base\n");
  git(repoRoot, "add", "-A");
  git(repoRoot, "commit", "-m", "init");
  svc = new GitWorkspaceService({
    repoRoot,
    worktreesRoot: join(root, "worktrees"),
    baseBranch: "main",
  });
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("GitWorkspaceService", () => {
  it("derives the branch name only from the session id", () => {
    expect(svc.branchFor("sess1")).toBe("agent/sess1");
  });

  it("prepare creates a worktree on a new branch off base (idempotent)", async () => {
    const a = await svc.prepare("sess1");
    expect(a.branch).toBe("agent/sess1");
    expect(a.baseBranch).toBe("main");
    // idempotent — preparing again returns the same cwd, no throw
    const b = await svc.prepare("sess1");
    expect(b.cwd).toBe(a.cwd);
  });

  it("commitTurn returns null when there is nothing to commit", async () => {
    const sha = await svc.commitTurn("sess1", "noop");
    expect(sha).toBeNull();
  });

  it("commits the agent's edits and shows them as a cumulative diff", async () => {
    const { cwd } = await svc.prepare("sess1");
    writeFileSync(join(cwd, "feature.ts"), "export const x = 1;\n");
    const sha = await svc.commitTurn("sess1", "add feature");
    expect(sha).toMatch(/^[0-9a-f]{40}$/);

    const diff = await svc.diff("sess1", "cumulative");
    expect(diff.patch).toContain("feature.ts");
    expect(diff.patch).toContain("export const x = 1;");
    expect(diff.files.map((f) => f.path)).toContain("feature.ts");
    const f = diff.files.find((f) => f.path === "feature.ts");
    expect(f?.additions).toBe(1);
  });

  it("turn diff shows only the latest commit, cumulative shows all", async () => {
    const { cwd } = await svc.prepare("sess1");
    writeFileSync(join(cwd, "second.ts"), "export const y = 2;\n");
    await svc.commitTurn("sess1", "add second");

    const turn = await svc.diff("sess1", "turn");
    expect(turn.patch).toContain("second.ts");
    expect(turn.patch).not.toContain("feature.ts");

    const cumulative = await svc.diff("sess1", "cumulative");
    expect(cumulative.patch).toContain("second.ts");
    expect(cumulative.patch).toContain("feature.ts");
  });

  it("isolates branches per session", async () => {
    const a = await svc.prepare("sessA");
    const b = await svc.prepare("sessB");
    expect(a.cwd).not.toBe(b.cwd);
    expect(a.branch).toBe("agent/sessA");
    expect(b.branch).toBe("agent/sessB");
  });

  it("resetTo restores the worktree to a prior checkpoint sha (#53 revert)", async () => {
    const { cwd } = await svc.prepare("sessReset");
    const base = await svc.currentHeadSha("sessReset");
    expect(base).toMatch(/^[0-9a-f]{40}$/);

    writeFileSync(join(cwd, "a.ts"), "export const a = 1;\n");
    const sha1 = await svc.commitTurn("sessReset", "turn 1");
    writeFileSync(join(cwd, "b.ts"), "export const b = 2;\n");
    await svc.commitTurn("sessReset", "turn 2");

    // Revert to turn 1: file B disappears, file A remains.
    await svc.resetTo("sessReset", sha1!);
    expect(existsSync(join(cwd, "a.ts"))).toBe(true);
    expect(existsSync(join(cwd, "b.ts"))).toBe(false);

    // Revert to the baseline: both files are gone.
    await svc.resetTo("sessReset", base);
    expect(existsSync(join(cwd, "a.ts"))).toBe(false);
    expect(existsSync(join(cwd, "b.ts"))).toBe(false);
  });
});
