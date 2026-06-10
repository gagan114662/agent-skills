import { loadEnv } from "../env.js";
import { FileConfigWorkspaceProvisioner, type WorkspaceProvisioner } from "../config/workspace.js";
import { createGitWorkspaceFromEnv } from "../git/default.js";
import { GitWorkspaceProvisioner } from "../git/provisioner.js";
import { EnvSecretsResolver } from "../runtime/secrets-resolver.js";
import { channelPoster } from "../runtime/default.js";
import { dbDeploymentStore } from "../db/repositories/deployments.js";
import type { SessionLogger } from "../runtime/manager.js";
import { createDeployProvider } from "./factory.js";
import { DeployManager } from "./manager.js";

/**
 * Build the production DeployManager (#73). The provider defaults to the no-spend dry-run backend
 * (`DEPLOY_PROVIDER=vercel` switches to the real adapter, loaded lazily). It resolves the session's
 * build source with the **same** provisioner the SessionManager/RunProcessManager use (#51 git-worktree
 * when a repo is configured, else the #58 file-copy dir), persists to the deployments table, and posts
 * the live URL into the channel via the shared channel poster.
 */
export function createDefaultDeployManager(logger: SessionLogger): DeployManager {
  const env = loadEnv();
  const gitWorkspace = createGitWorkspaceFromEnv();
  const provisioner: WorkspaceProvisioner = gitWorkspace
    ? new GitWorkspaceProvisioner(gitWorkspace)
    : new FileConfigWorkspaceProvisioner({ logger });
  return new DeployManager({
    provider: createDeployProvider(env.deploy),
    store: dbDeploymentStore,
    poster: channelPoster,
    provisioner,
    secrets: new EnvSecretsResolver(),
    logger,
  });
}
