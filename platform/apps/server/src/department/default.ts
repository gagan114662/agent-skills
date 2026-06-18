/**
 * Production wiring for the named-department roster (#371, ADR-0371). Binds the pure {@link
 * DepartmentService} to the real repos: the per-workspace caps from the layered config (#58), the present
 * handles + persona minting from the #59 persona path (reusing `definePersona` exactly as the #123
 * marketing seed does), the member counts from the #2 members repo, and the "decisions captured" count from
 * the #13 approval requests. No new launch authority and no send/spend: seeding mints identity personas
 * only; every real action still flows through the #13 gate.
 */
import { generateAgentToken } from "../auth/secrets.js";
import { loadConfig } from "../config/loader.js";
import { listRequests } from "../db/repositories/approvals.js";
import { listWorkspaceMembers } from "../db/repositories/members.js";
import { definePersona, getPersonaByHandle, listPersonas } from "../db/repositories/personas.js";
import { resolveDepartmentCaps } from "./caps.js";
import { isCapturedDecision } from "./rail.js";
import { DepartmentService, type DepartmentDeps } from "./service.js";

export function createDefaultDepartmentService(): DepartmentService {
  const deps: DepartmentDeps = {
    caps: (workspaceId) => resolveDepartmentCaps(loadConfig(workspaceId).department),
    listPresentHandles: async (workspaceId) => (await listPersonas(workspaceId)).map((p) => p.name),
    getPersonaByHandle: async (workspaceId, handle) => {
      const p = await getPersonaByHandle(workspaceId, handle);
      return p ? { id: p.id, agentMemberId: p.agentMemberId } : undefined;
    },
    createPersona: async (spec) => {
      const { hash } = generateAgentToken();
      const p = await definePersona(
        {
          workspaceId: spec.workspaceId,
          name: spec.name,
          systemPrompt: spec.systemPrompt,
          allowedTools: spec.allowedTools,
          model: spec.model,
          isBuiltin: true,
          tokenHash: hash,
        },
        spec.createdByMemberId,
      );
      return { id: p.id, agentMemberId: p.agentMemberId };
    },
    countMembers: async (workspaceId) => {
      const members = await listWorkspaceMembers(workspaceId);
      return {
        humans: members.filter((m) => m.kind === "human").length,
        agents: members.filter((m) => m.kind === "agent").length,
      };
    },
    countDecisionsCaptured: async (workspaceId) =>
      (await listRequests(workspaceId)).filter((r) => isCapturedDecision(r.status)).length,
  };
  return new DepartmentService(deps);
}
