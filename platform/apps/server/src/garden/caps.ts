import type { GardenConfig } from "../config/schema.js";

/**
 * Resolve the Agent Garden policy (#284, ADR-0284) from the layered config (#58) with hard defaults —
 * mirrors `agent-registry/caps.ts`. **`enabled` defaults OFF** and **owner-workspace-first**
 * (`ownerWorkspaceOnly: true`): a deployment that sets no `garden` block exposes the contract catalog
 * read-only (browse is harmless) but lets NO workspace manage (enable/disable) any agent, so today's
 * behavior is byte-for-byte unchanged. ipop.ai opts in via the managed layer / `RELOAD_GARDEN_ENABLED`.
 *
 * The flag governs only whether the surface can MANAGE. Enabling an `external_send` agent stays #13-gated
 * regardless (the structural always-gate lives in the pure `decideGardenEnable`, not in this flag).
 */
export interface GardenCaps {
  /** The manage flag — the catalog lists regardless; enable/disable is OFF unless this is true. */
  enabled: boolean;
  /** Restrict managing the Garden to the owner workspace first (default true). */
  ownerWorkspaceOnly: boolean;
  /** The owner's own workspace id (owner-first rollout marker), or null. */
  ownerWorkspaceId: string | null;
}

export const GARDEN_DEFAULTS: GardenCaps = {
  enabled: false,
  ownerWorkspaceOnly: true,
  ownerWorkspaceId: null,
};

export function resolveGardenCaps(cfg: GardenConfig | undefined): GardenCaps {
  const d = GARDEN_DEFAULTS;
  return {
    enabled: cfg?.enabled ?? d.enabled,
    ownerWorkspaceOnly: cfg?.ownerWorkspaceOnly ?? d.ownerWorkspaceOnly,
    ownerWorkspaceId: cfg?.ownerWorkspaceId ?? d.ownerWorkspaceId,
  };
}

/** Is this workspace the owner's own (the owner-workspace-first rollout)? Pure + total. */
export function isOwnerWorkspace(caps: GardenCaps, workspaceId: string): boolean {
  return caps.ownerWorkspaceId !== null && caps.ownerWorkspaceId === workspaceId;
}

/**
 * May this workspace MANAGE the Garden (enable/disable agents)? True iff the flag is on AND (the
 * owner-first restriction is off OR this is the owner workspace). When false the catalog still lists
 * read-only, but every enable/disable is refused and no agent is reported `active`. Pure + total.
 */
export function isGardenManageInScope(caps: GardenCaps, workspaceId: string): boolean {
  if (!caps.enabled) return false;
  return !caps.ownerWorkspaceOnly || isOwnerWorkspace(caps, workspaceId);
}
