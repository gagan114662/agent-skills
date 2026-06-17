import { describe, it, expect } from "vitest";
import {
  AGENT_COLLABORATION_DEFAULTS,
  resolveAgentCollaborationCaps,
  isSpawnEnabledForWorkspace,
} from "../../src/subagents/collaboration.js";

/**
 * #319 — the gated subagent-spawn provisioning. Spawn multiplies model spend (a bounded-autonomy concern,
 * #200 §5), so it ships **default OFF** and **owner-workspace-first**, mirroring `venture`/`agentRegistry`.
 * These pin that policy on the pure resolver + gate so a config change can never silently provision spawn
 * for every tenant.
 */
describe("resolveAgentCollaborationCaps (#319)", () => {
  it("defaults to OFF + owner-first when no config is set", () => {
    expect(resolveAgentCollaborationCaps(undefined)).toEqual(AGENT_COLLABORATION_DEFAULTS);
    expect(AGENT_COLLABORATION_DEFAULTS.enabled).toBe(false);
    expect(AGENT_COLLABORATION_DEFAULTS.ownerWorkspaceOnly).toBe(true);
    expect(AGENT_COLLABORATION_DEFAULTS.ownerWorkspaceId).toBeUndefined();
  });

  it("applies a partial config over the hard defaults", () => {
    const caps = resolveAgentCollaborationCaps({ enabled: true, ownerWorkspaceId: "ws_owner" });
    expect(caps).toEqual({ enabled: true, ownerWorkspaceOnly: true, ownerWorkspaceId: "ws_owner" });
  });
});

describe("isSpawnEnabledForWorkspace (#319)", () => {
  it("is OFF for everyone when the master flag is off", () => {
    const caps = resolveAgentCollaborationCaps({ enabled: false, ownerWorkspaceId: "ws_owner" });
    expect(isSpawnEnabledForWorkspace(caps, "ws_owner")).toBe(false);
    expect(isSpawnEnabledForWorkspace(caps, "ws_other")).toBe(false);
  });

  it("enabled + owner-first provisions ONLY the named owner workspace", () => {
    const caps = resolveAgentCollaborationCaps({ enabled: true, ownerWorkspaceId: "ws_owner" });
    expect(isSpawnEnabledForWorkspace(caps, "ws_owner")).toBe(true);
    expect(isSpawnEnabledForWorkspace(caps, "ws_other")).toBe(false);
  });

  it("enabled WITHOUT naming the owner workspace provisions for nobody (safest default)", () => {
    const caps = resolveAgentCollaborationCaps({ enabled: true });
    expect(isSpawnEnabledForWorkspace(caps, "ws_owner")).toBe(false);
    expect(isSpawnEnabledForWorkspace(caps, "anything")).toBe(false);
  });

  it("ownerWorkspaceOnly:false provisions for every tenant once the owner has proven the path", () => {
    const caps = resolveAgentCollaborationCaps({ enabled: true, ownerWorkspaceOnly: false });
    expect(isSpawnEnabledForWorkspace(caps, "ws_owner")).toBe(true);
    expect(isSpawnEnabledForWorkspace(caps, "ws_other")).toBe(true);
  });
});
