import type {
  PreparedWorkspace,
  WorkspacePrepareInput,
  WorkspaceProvisioner,
} from "../config/workspace.js";
import type { GitWorkspaceService } from "./workspace.js";

/**
 * Adapts {@link GitWorkspaceService} to the #58 {@link WorkspaceProvisioner} seam (#51): on launch it
 * prepares the session's git worktree and hands its `cwd` to the SessionManager, so the harness's
 * file edits land on branch `agent/<sessionId>`. Opt-in (wired only when a repo is configured), so
 * with no git repo the default file provisioner is used and existing #25/#58 sessions are unchanged.
 */
export class GitWorkspaceProvisioner implements WorkspaceProvisioner {
  constructor(private readonly git: GitWorkspaceService) {}

  async prepare(input: WorkspacePrepareInput): Promise<PreparedWorkspace> {
    const prepared = await this.git.prepare(input.sessionId);
    return { cwd: prepared.cwd };
  }
}
