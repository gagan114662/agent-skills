import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { DiffFileStat, DiffMode } from "@reload/shared";
import { parseNumstat } from "./diff.js";
import { SpawnGitRunner, type GitRunner } from "./runner.js";

export interface GitWorkspaceConfig {
  /** The source repository the agent's worktrees branch off of. */
  repoRoot: string;
  /** Directory under which per-session worktrees are created (`<root>/<sessionId>`). */
  worktreesRoot: string;
  /** The branch every session branches from and diffs/PRs against. Default `main`. */
  baseBranch: string;
}

export interface PreparedGitWorkspace {
  cwd: string;
  branch: string;
  baseBranch: string;
}

export interface GitDiffResult {
  branch: string;
  baseBranch: string;
  mode: DiffMode;
  patch: string;
  files: DiffFileStat[];
}

/** Git identity used for agent commits — kept off the host's global config so tests are hermetic. */
const COMMIT_IDENTITY = [
  "-c",
  "user.name=Reload Agent",
  "-c",
  "user.email=agent@reload.local",
];

/**
 * GitWorkspaceService (#51) — gives each agent session an isolated git worktree on branch
 * `agent/<sessionId>` off a configured base branch, and computes the diff the review surface renders.
 *
 * Every git ref is derived from the **server-issued** `sessionId`; no client string ever reaches a
 * ref or a shell (args are an argv array on {@link GitRunner}). Commit is **lazy** — the diff/PR
 * routes call {@link commitTurn} before reading, so a session's edits become a reviewable diff
 * without touching the heavily-tested SessionManager (zero blast radius on #25).
 */
export class GitWorkspaceService {
  private readonly cfg: GitWorkspaceConfig;
  private readonly runner: GitRunner;

  constructor(cfg: Partial<GitWorkspaceConfig> & { repoRoot: string; worktreesRoot: string }, runner: GitRunner = new SpawnGitRunner()) {
    this.cfg = { baseBranch: "main", ...cfg };
    this.runner = runner;
  }

  /** The source repository PRs are opened in. */
  get repoRoot(): string {
    return this.cfg.repoRoot;
  }

  /** The base branch sessions diff/PR against. */
  get baseBranch(): string {
    return this.cfg.baseBranch;
  }

  /** True once a session's worktree has been prepared (so a diff/commit is possible). */
  hasWorktree(sessionId: string): boolean {
    return existsSync(this.worktreePathFor(sessionId));
  }

  /** The deterministic branch a session works on. */
  branchFor(sessionId: string): string {
    return `agent/${sessionId}`;
  }

  /** The deterministic worktree path for a session. */
  worktreePathFor(sessionId: string): string {
    return join(this.cfg.worktreesRoot, sessionId);
  }

  /**
   * Ensure a worktree + branch exists for the session and return its working dir. Idempotent: a
   * second call for the same session returns the existing worktree without re-adding it.
   */
  async prepare(sessionId: string): Promise<PreparedGitWorkspace> {
    const branch = this.branchFor(sessionId);
    const cwd = this.worktreePathFor(sessionId);
    if (!existsSync(cwd)) {
      mkdirSync(this.cfg.worktreesRoot, { recursive: true });
      // `worktree add -b <branch> <path> <base>` creates the branch off base in a fresh checkout.
      await this.git(this.cfg.repoRoot, ["worktree", "add", "-b", branch, cwd, this.cfg.baseBranch]);
    }
    return { cwd, branch, baseBranch: this.cfg.baseBranch };
  }

  /**
   * Stage everything in the session's worktree and commit it as one turn. Returns the new head sha,
   * or `null` when there was nothing to commit (so the route can avoid empty commits).
   */
  async commitTurn(sessionId: string, message: string): Promise<string | null> {
    const cwd = this.worktreePathFor(sessionId);
    await this.git(cwd, ["add", "-A"]);
    // `diff --cached --quiet` exits 1 iff there are staged changes.
    const staged = await this.runner.run(["diff", "--cached", "--quiet"], { cwd });
    if (staged.code === 0) return null;
    await this.git(cwd, [...COMMIT_IDENTITY, "commit", "-m", message]);
    const head = await this.git(cwd, ["rev-parse", "HEAD"]);
    return head.trim();
  }

  /**
   * The session's diff in the requested mode:
   *  - `cumulative` — `base...HEAD`, all the work on the session branch.
   *  - `turn` — the latest commit (`HEAD~1 HEAD`); falls back to cumulative when there is only one
   *    commit (no `HEAD~1`).
   */
  async diff(sessionId: string, mode: DiffMode): Promise<GitDiffResult> {
    const cwd = this.worktreePathFor(sessionId);
    const branch = this.branchFor(sessionId);
    const base = this.cfg.baseBranch;

    let range: string[];
    if (mode === "turn" && (await this.hasParent(cwd))) {
      range = ["HEAD~1", "HEAD"];
    } else {
      range = [`${base}...HEAD`];
    }

    const patch = await this.git(cwd, ["diff", ...range]);
    const numstat = await this.git(cwd, ["diff", "--numstat", ...range]);
    return { branch, baseBranch: base, mode, patch, files: parseNumstat(numstat) };
  }

  /** Remove a session's worktree (best-effort cleanup; never throws). */
  async removeWorktree(sessionId: string): Promise<void> {
    const cwd = this.worktreePathFor(sessionId);
    await this.runner.run(["worktree", "remove", "--force", cwd], { cwd: this.cfg.repoRoot });
  }

  /** True when HEAD has a parent commit (so a `turn` diff against HEAD~1 is valid). */
  private async hasParent(cwd: string): Promise<boolean> {
    const r = await this.runner.run(["rev-parse", "--verify", "HEAD~1"], { cwd });
    return r.code === 0;
  }

  /** Run git, throwing on a non-zero exit with the captured stderr. Returns stdout. */
  private async git(cwd: string, args: string[]): Promise<string> {
    const r = await this.runner.run(args, { cwd });
    if (r.code !== 0) {
      throw new Error(`git ${args.join(" ")} failed (${r.code}): ${r.stderr.trim()}`);
    }
    return r.stdout;
  }
}
