import { loadConfig } from "../config/loader.js";
import { resolveGatePricingCaps } from "./caps.js";
import { GatePricingService } from "./service.js";
import {
  readEvidenceWindow,
  listEvidenceActionTypes,
  recordBoundaryChange,
} from "../db/repositories/gate-evidence.js";
import { upsertPolicy, deletePolicy, listPolicies } from "../db/repositories/approvals.js";
import type { SessionLogger } from "../runtime/manager.js";

/**
 * Production wiring for Evidence-Priced Autonomy (#119, ADR-0119). Every seam is a real repo: the
 * trailing-window read, the work-list, the #95 policy toggle (`upsertPolicy`/`deletePolicy`), and the
 * `gate_boundary_changes` audit. RELAX creates a system-owned auto-approve rule (`require_approval =
 * false`, `createdByMemberId = null`); RETIGHTEN revokes it by id. The pricer is config default-OFF
 * (`gatePricing.enabled`), so wiring it changes nothing until an operator opts in. It is driven
 * per-workspace via `GatePricingService.tick(workspaceId)` (tests drive it; a fleet scheduler can drive
 * it on infrastructure time, like the venture/watchdog ticks).
 */
export function createDefaultGatePricingService(logger: SessionLogger): GatePricingService {
  return new GatePricingService({
    caps: (workspaceId) => resolveGatePricingCaps(loadConfig(workspaceId).gatePricing),
    listActionTypes: listEvidenceActionTypes,
    readWindow: readEvidenceWindow,
    currentlyRelaxed: async (workspaceId, actionType) => {
      const rule = (await listPolicies(workspaceId)).find((p) => p.actionType === actionType);
      return {
        relaxed: !!rule && rule.requireApproval === false,
        ruleId: rule?.id ?? null,
      };
    },
    relax: async (workspaceId, actionType) => {
      const rule = await upsertPolicy({
        workspaceId,
        actionType,
        requireApproval: false,
        maxAutoAmount: null,
        createdByMemberId: null,
      });
      return rule.id;
    },
    retighten: async (workspaceId, ruleId) => {
      await deletePolicy(ruleId, workspaceId);
    },
    audit: async (change) => {
      await recordBoundaryChange(change);
    },
    logger,
  });
}
