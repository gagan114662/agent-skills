/**
 * Production wiring for the named-department roster (#371, ADR-0371). Binds the pure {@link
 * DepartmentService} to the real repos: the per-workspace caps from the layered config (#58), the present
 * handles + persona minting from the #59 persona path (reusing `definePersona` exactly as the #123
 * marketing seed does), the member counts from the #2 members repo, and the "decisions captured" count from
 * the #513 shared decision store (the live decisions agents recorded to the browsable memory graph). No new
 * launch authority and no send/spend: seeding mints identity personas
 * only; every real action still flows through the #13 gate.
 */
import { generateAgentToken } from "../auth/secrets.js";
import { loadConfig } from "../config/loader.js";
import { countLiveDecisions } from "../db/repositories/agent-decisions.js";
import { listWorkspaceMembers } from "../db/repositories/members.js";
import { definePersona, getPersonaByHandle, listPersonas } from "../db/repositories/personas.js";
import { resolveDepartmentCaps } from "./caps.js";
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
    // #513: the "decisions captured" footer is now backed by the real shared decision store — the live
    // (non-superseded) decisions agents have recorded to the browsable memory graph, not a proxy count of
    // approval requests. This is the number the Memory view can actually show.
    countDecisionsCaptured: async (workspaceId) => countLiveDecisions(workspaceId),
  };
  return new DepartmentService(deps);
}
