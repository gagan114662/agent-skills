import { listAgents } from "../db/repositories/auth.js";
import { listChannels } from "../db/repositories/channels.js";
import { dbWorkspacePlanStore } from "../db/repositories/plans.js";
import type { PlanQuotaReaders } from "./entitlements.js";

export const defaultPlanQuotaReaders: PlanQuotaReaders = {
  activePlans: dbWorkspacePlanStore,
  async countAgents(workspaceId) {
    return (await listAgents(workspaceId)).filter((agent) => !agent.deactivatedAt).length;
  },
  async countChannels(workspaceId) {
    return (await listChannels(workspaceId)).length;
  },
};
