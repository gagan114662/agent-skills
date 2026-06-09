import { isAbsolute, join } from "node:path";
import { GitWorkspaceService } from "./workspace.js";

/**
 * Build the production GitWorkspaceService from env (#51), or `undefined` when no repo is configured
 * — in which case the git/PR routes return 501 and sessions keep the #25/#58 plain-folder behavior.
 * Opt-in by design, exactly like the #25 sandbox runtime and the `gh` provider.
 *
 *   GIT_WORKSPACE_REPO        absolute path to the source repo agents branch off of (enables the feature)
 *   GIT_WORKSPACE_WORKTREES   where per-session worktrees live (default `<repo>/.reload-worktrees`)
 *   GIT_BASE_BRANCH           branch sessions diff/PR against (default `main`)
 */
export function createGitWorkspaceFromEnv(
  source: NodeJS.ProcessEnv = process.env,
): GitWorkspaceService | undefined {
  const repoRoot = source.GIT_WORKSPACE_REPO;
  if (!repoRoot || !isAbsolute(repoRoot)) return undefined;
  const worktreesRoot = source.GIT_WORKSPACE_WORKTREES ?? join(repoRoot, ".reload-worktrees");
  const baseBranch = source.GIT_BASE_BRANCH ?? "main";
  return new GitWorkspaceService({ repoRoot, worktreesRoot, baseBranch });
}
