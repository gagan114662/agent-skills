import {
  getCloudWorkspace,
  setCloudWorkspaceStatus,
  recordCloudWorkspaceSnapshot,
  markCloudWorkspaceSetupCompleted,
  touchCloudWorkspace,
  listSleepCandidates,
} from "../db/repositories/cloud-workspaces.js";
import {
  CloudWorkspaceManager,
  type CloudWorkspaceLogger,
  type CloudWorkspaceSandbox,
  type CloudWorkspaceStore,
} from "./manager.js";
import { ProviderCloudWorkspaceSandbox } from "./sandbox.js";
import { VercelSandboxProvider } from "../runtime/vercel-provider.js";
import { loadEnv } from "../env.js";

/** Repository-backed store (exported so integration tests reuse real persistence). */
export const cloudWorkspaceStore: CloudWorkspaceStore = {
  get: getCloudWorkspace,
  setStatus: setCloudWorkspaceStatus,
  recordSnapshot: recordCloudWorkspaceSnapshot,
  markSetupCompleted: markCloudWorkspaceSetupCompleted,
  touch: touchCloudWorkspace,
  listSleepCandidates,
};

/**
 * Build the production CloudWorkspaceManager over the real repositories (#55). When
 * `AGENT_RUNTIME=sandbox` (#82), the live-microVM seam is wired so sleep/wake snapshot+resume a
 * real Vercel sandbox (the SDK loads lazily on first use); the default `local`/`demo` posture has
 * no microVM, so it stays a status-only transition.
 */
export function createDefaultCloudWorkspaceManager(
  logger: CloudWorkspaceLogger,
): CloudWorkspaceManager {
  const env = loadEnv().agent;
  const sandbox: CloudWorkspaceSandbox | undefined =
    env.runtime === "sandbox"
      ? new ProviderCloudWorkspaceSandbox(new VercelSandboxProvider(), {
          caps: env.caps,
          source: env.sandboxSource,
        })
      : undefined;
  return new CloudWorkspaceManager({ store: cloudWorkspaceStore, logger, sandbox });
}
