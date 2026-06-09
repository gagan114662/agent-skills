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
  type CloudWorkspaceStore,
} from "./manager.js";

/** Repository-backed store (exported so integration tests reuse real persistence). */
export const cloudWorkspaceStore: CloudWorkspaceStore = {
  get: getCloudWorkspace,
  setStatus: setCloudWorkspaceStatus,
  recordSnapshot: recordCloudWorkspaceSnapshot,
  markSetupCompleted: markCloudWorkspaceSetupCompleted,
  touch: touchCloudWorkspace,
  listSleepCandidates,
};

/** Build the production CloudWorkspaceManager over the real repositories (#55). */
export function createDefaultCloudWorkspaceManager(
  logger: CloudWorkspaceLogger,
): CloudWorkspaceManager {
  return new CloudWorkspaceManager({ store: cloudWorkspaceStore, logger });
}
