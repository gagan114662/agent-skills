import { listWorkspaceIds } from "../db/repositories/workspaces.js";
import { sweepExpired } from "../db/repositories/approvals.js";
import type { SessionLogger } from "../runtime/manager.js";
import { ApprovalExpiryEngine } from "./expiry-engine.js";

export function createDefaultApprovalExpiryEngine(logger: SessionLogger): ApprovalExpiryEngine {
  return new ApprovalExpiryEngine({
    store: {
      listWorkspaceIds,
      sweepExpired,
    },
    logger,
  });
}
