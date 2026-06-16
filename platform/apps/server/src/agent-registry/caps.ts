import type { AgentRegistryConfig } from "../config/schema.js";

/**
 * Resolve the Agent Registry + A2A policy (#282, ADR-0282) from the layered config (#58) with hard
 * defaults — mirrors `discovery/caps.ts`. **`enabled` defaults OFF** and **owner-workspace-first**
 * (`ownerWorkspaceOnly: true`): a deployment that sets no `agentRegistry` block exposes the contract
 * catalog read-only (harmless) but enables NO A2A call in any workspace, so today's behavior is
 * byte-for-byte unchanged. ipop.ai opts in via the managed layer / `RELOAD_AGENT_REGISTRY_ENABLED`.
 * `maxCallDepth` is the bounded-autonomy depth cap the A2A decision enforces (premortem #200 §5).
 */
export interface AgentRegistryCaps {
  /** The A2A feature flag — discovery lists regardless; A2A calls are OFF unless this is true. */
  enabled: boolean;
  /** Restrict A2A to the owner workspace first (default true). */
  ownerWorkspaceOnly: boolean;
  /** Hard cap on A2A call depth (bounded autonomy). */
  maxCallDepth: number;
  /** The owner's own workspace id (owner-first rollout marker), or null. */
  ownerWorkspaceId: string | null;
}

export const AGENT_REGISTRY_DEFAULTS: AgentRegistryCaps = {
  enabled: false,
  ownerWorkspaceOnly: true,
  maxCallDepth: 3,
  ownerWorkspaceId: null,
};

export function resolveAgentRegistryCaps(cfg: AgentRegistryConfig | undefined): AgentRegistryCaps {
  const d = AGENT_REGISTRY_DEFAULTS;
  return {
    enabled: cfg?.enabled ?? d.enabled,
    ownerWorkspaceOnly: cfg?.ownerWorkspaceOnly ?? d.ownerWorkspaceOnly,
    maxCallDepth: cfg?.maxCallDepth ?? d.maxCallDepth,
    ownerWorkspaceId: cfg?.ownerWorkspaceId ?? d.ownerWorkspaceId,
  };
}

/** Is this workspace the owner's own (the owner-workspace-first rollout)? Pure + total. */
export function isOwnerWorkspace(caps: AgentRegistryCaps, workspaceId: string): boolean {
  return caps.ownerWorkspaceId !== null && caps.ownerWorkspaceId === workspaceId;
}
