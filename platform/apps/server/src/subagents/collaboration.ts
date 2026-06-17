import type { AgentCollaborationConfig } from "../config/schema.js";
import { loadConfig } from "../config/loader.js";
import { SPAWN_TOOLS } from "./scope.js";

/**
 * Agent collaboration caps (#319, ADR-0319) — pure policy for whether a scoped fleet session is
 * provisioned with the subagent-**spawn** tool so a department lead can delegate to a teammate
 * ("collaborate"). Mirrors `venture/caps.ts` / `agent-registry/caps.ts`: a two-pronged gate that is
 * **default OFF** and **owner-workspace-first**, resolved with hard defaults from the layered config.
 *
 * Spawn is a model-spend amplifier (a lead that can spin up subagents multiplies token cost and is a
 * bounded-autonomy concern, #200 §5), so it ships OFF and rolls out to the owner's own workspace first —
 * a deployment that sets nothing keeps today's drafts-only tool surface exactly, so behavior is unchanged.
 */
export interface AgentCollaborationCaps {
  /** Provision the spawn tool into scoped sessions. OFF by default. */
  enabled: boolean;
  /**
   * Roll the capability out owner-workspace-first (default true): even when `enabled`, an
   * `ownerWorkspaceOnly` deployment only provisions spawn for `ownerWorkspaceId`; every other tenant keeps
   * today's drafts-only surface. Set false to provision for all tenants once the owner has proven the path.
   */
  ownerWorkspaceOnly: boolean;
  /** The owner's own workspace id — the capability dogfoods here first. */
  ownerWorkspaceId: string | undefined;
}

export const AGENT_COLLABORATION_DEFAULTS: AgentCollaborationCaps = {
  enabled: false,
  ownerWorkspaceOnly: true,
  ownerWorkspaceId: undefined,
};

/** Resolve the collaboration caps from the layered config, applying hard defaults. */
export function resolveAgentCollaborationCaps(
  cfg: AgentCollaborationConfig | undefined,
): AgentCollaborationCaps {
  return {
    enabled: cfg?.enabled ?? AGENT_COLLABORATION_DEFAULTS.enabled,
    ownerWorkspaceOnly: cfg?.ownerWorkspaceOnly ?? AGENT_COLLABORATION_DEFAULTS.ownerWorkspaceOnly,
    ownerWorkspaceId: cfg?.ownerWorkspaceId ?? AGENT_COLLABORATION_DEFAULTS.ownerWorkspaceId,
  };
}

/**
 * Pure: is the spawn tool PROVISIONED for this specific workspace (#319)? The capability rolls out
 * owner-workspace-first — so even when the master `enabled` flag is on, an `ownerWorkspaceOnly` deployment
 * (the default) only provisions for the named owner workspace, and every other tenant keeps today's
 * drafts-only surface. Turning `enabled` on WITHOUT naming the owner workspace provisions for nobody (the
 * safest default, matching `agentRegistry`/`venture`/`delivery`). Set `ownerWorkspaceOnly` false for all.
 */
export function isSpawnEnabledForWorkspace(
  caps: AgentCollaborationCaps,
  workspaceId: string,
): boolean {
  if (!caps.enabled) return false;
  if (!caps.ownerWorkspaceOnly) return true;
  return caps.ownerWorkspaceId !== undefined && caps.ownerWorkspaceId === workspaceId;
}

/**
 * Wiring convenience (#319): the extra tools to provision for `workspaceId`, resolved from the layered
 * config. Returns the {@link SPAWN_TOOLS} only when spawn is enabled for this workspace (default OFF,
 * owner-first), else `[]`. Bound to `SubagentService.extraToolsForWorkspace` at the composition root.
 */
export function spawnToolsForWorkspace(workspaceId: string): string[] {
  const caps = resolveAgentCollaborationCaps(loadConfig(workspaceId).agentCollaboration);
  return isSpawnEnabledForWorkspace(caps, workspaceId) ? [...SPAWN_TOOLS] : [];
}
