import { FileConfigWorkspaceProvisioner, type WorkspaceProvisioner } from "../config/workspace.js";
import { createGitWorkspaceFromEnv } from "../git/default.js";
import { GitWorkspaceProvisioner } from "../git/provisioner.js";
import type { SessionLogger } from "../runtime/manager.js";
import { RunProcessManager } from "./manager.js";

/**
 * Build the production RunProcessManager (#56). It resolves a session's working dir with the **same**
 * provisioner the SessionManager uses (#51 git-worktree when a repo is configured, else the #58
 * file-copy dir) so the app runs in the agent's actual worktree.
 */
export function createDefaultRunProcessManager(logger: SessionLogger): RunProcessManager {
  const gitWorkspace = createGitWorkspaceFromEnv();
  const provisioner: WorkspaceProvisioner = gitWorkspace
    ? new GitWorkspaceProvisioner(gitWorkspace)
    : new FileConfigWorkspaceProvisioner({ logger });
  return new RunProcessManager({ provisioner, logger });
}
