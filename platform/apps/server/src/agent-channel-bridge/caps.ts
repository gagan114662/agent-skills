/**
 * Agent→channel posting policy resolution (#370, ADR-0370) — mirrors `durable-workflow/caps.ts` /
 * `agent-registry/caps.ts`. Posting agent coordination output into chat channels is a new way for the
 * fleet to talk, so it ships **default OFF**, owner-workspace-first (epic #359 rails + premortem #200 §4):
 * a deployment that sets no `agentChannelPosting` block keeps the channels exactly as they are today —
 * empty of agent chatter, every panel reading the same real-but-quiet data. Even when `enabled`, an
 * `ownerWorkspaceOnly` deployment (the default) only lets the owner's own workspace post; every other
 * tenant is byte-for-byte untouched. Turning `enabled` on WITHOUT naming `ownerWorkspaceId` posts for
 * nobody (the safest default, matching `durableWorkflow`/`agentRegistry`/`venture`). Pure ⇒ unit-testable.
 */
import type { AgentChannelPostingConfig } from "../config/schema.js";

export interface AgentChannelPostingCaps {
  /** Master flag for routing agent coordination output into channel messages. OFF by default. */
  enabled: boolean;
  /**
   * Roll out owner-workspace-first (the default): when true, only `ownerWorkspaceId` posts even if
   * `enabled`; every other tenant keeps today's quiet channels. Set false to enable for all tenants.
   */
  ownerWorkspaceOnly: boolean;
  /** The owner's own workspace id — the bridge dogfoods here first. */
  ownerWorkspaceId: string | undefined;
}

export const AGENT_CHANNEL_POSTING_DEFAULTS: AgentChannelPostingCaps = {
  enabled: false,
  ownerWorkspaceOnly: true,
  ownerWorkspaceId: undefined,
};

export function resolveAgentChannelPostingCaps(
  cfg: AgentChannelPostingConfig | undefined,
): AgentChannelPostingCaps {
  return {
    enabled: cfg?.enabled ?? AGENT_CHANNEL_POSTING_DEFAULTS.enabled,
    ownerWorkspaceOnly: cfg?.ownerWorkspaceOnly ?? AGENT_CHANNEL_POSTING_DEFAULTS.ownerWorkspaceOnly,
    ownerWorkspaceId: cfg?.ownerWorkspaceId ?? AGENT_CHANNEL_POSTING_DEFAULTS.ownerWorkspaceId,
  };
}

/**
 * Pure: is agent→channel posting ENABLED for this specific workspace? Default OFF, owner-workspace-first —
 * even when the master `enabled` flag is on, an `ownerWorkspaceOnly` deployment (the default) only lets the
 * named owner workspace post; turning `enabled` on WITHOUT naming the owner posts for nobody (the safest
 * default, matching `durableWorkflow`/`agentRegistry`). Set `ownerWorkspaceOnly` false to enable for all.
 */
export function isAgentChannelPostingEnabledForWorkspace(
  caps: AgentChannelPostingCaps,
  workspaceId: string,
): boolean {
  if (!caps.enabled) return false;
  if (!caps.ownerWorkspaceOnly) return true;
  return caps.ownerWorkspaceId !== undefined && caps.ownerWorkspaceId === workspaceId;
}
