/**
 * Production wiring for the Agent Garden service (#284, ADR-0284). Binds the pure decisions to the real
 * seams:
 *
 *   - `caps` — the layered #58 config (`garden` block → `resolveGardenCaps`). Default OFF, owner-first.
 *   - `listPresentHandles` — the seeded personas (#123), the production-grounded fact `projectGardenView`
 *     reconciles the stored state against (premortem #200 FM#3).
 *   - `getStates` / `setState` — the `garden_agent_enablements` repo (one row per workspace+handle).
 *   - `park` — parks a PENDING `garden.enable_agent` #13 request (a structural always-gate the owner
 *     approves; recorded-only). There is no autonomous-enable path for an `external_send` agent. The
 *     summary is built STRUCTURALLY from the already-validated handle/displayName — never by interpolating
 *     raw metadata (injection defense).
 */
import { listPersonas } from "../db/repositories/personas.js";
import { loadConfig } from "../config/loader.js";
import { createRequest } from "../db/repositories/approvals.js";
import { GARDEN_ENABLE_AGENT_ACTION } from "../approvals/policy.js";
import { dbGardenStateStore } from "../db/repositories/garden.js";
import { resolveGardenCaps } from "./caps.js";
import { GardenService, type GardenDeps } from "./service.js";

/** Build the production-wired Agent Garden service over the real repos + the #13 approval queue. */
export function createDefaultGardenService(): GardenService {
  const deps: GardenDeps = {
    caps: (workspaceId) => resolveGardenCaps(loadConfig(workspaceId).garden),
    listPresentHandles: async (workspaceId) => (await listPersonas(workspaceId)).map((p) => p.name),
    getStates: (workspaceId) => dbGardenStateStore.getStates(workspaceId),
    setState: (workspaceId, handle, state) => dbGardenStateStore.setState(workspaceId, handle, state),
    park: async (input) => {
      const req = await createRequest({
        workspaceId: input.workspaceId,
        requesterMemberId: input.requesterMemberId,
        actionType: GARDEN_ENABLE_AGENT_ACTION,
        payload: {
          handle: input.contract.handle,
          department: input.contract.department,
          riskTier: input.contract.riskTier,
          gatedActions: input.contract.gatedActions,
        },
        amount: null,
        // Structural summary from the validated handle/displayName — never raw metadata (injection defense).
        summary: `Switch on ${input.contract.displayName} (@${input.contract.handle})`.slice(0, 140),
        status: "pending", // CONSENT, owner-gated — parks in the decision queue (ADR-0284).
        expiresAt: null,
        events: [
          {
            type: "requested",
            detail: {
              source: "agent-garden",
              handle: input.contract.handle,
              riskTier: input.contract.riskTier,
            },
          },
        ],
      });
      return { id: req.id };
    },
  };
  return new GardenService(deps);
}
