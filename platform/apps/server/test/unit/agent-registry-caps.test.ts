import { describe, it, expect } from "vitest";
import {
  resolveAgentRegistryCaps,
  isOwnerWorkspace,
  AGENT_REGISTRY_DEFAULTS,
} from "../../src/agent-registry/caps.js";

describe("agent-registry/caps — resolveAgentRegistryCaps", () => {
  it("defaults OFF and owner-workspace-first when no config is supplied", () => {
    const caps = resolveAgentRegistryCaps(undefined);
    expect(caps.enabled).toBe(false);
    expect(caps.ownerWorkspaceOnly).toBe(true);
    expect(caps.maxCallDepth).toBe(AGENT_REGISTRY_DEFAULTS.maxCallDepth);
    expect(caps.ownerWorkspaceId).toBeNull();
  });

  it("an empty config block keeps the defaults (a deployment that sets nothing is unchanged)", () => {
    expect(resolveAgentRegistryCaps({})).toEqual(AGENT_REGISTRY_DEFAULTS);
  });

  it("applies the supplied overrides", () => {
    const caps = resolveAgentRegistryCaps({
      enabled: true,
      ownerWorkspaceOnly: false,
      maxCallDepth: 5,
      ownerWorkspaceId: "ws-owner",
    });
    expect(caps).toEqual({
      enabled: true,
      ownerWorkspaceOnly: false,
      maxCallDepth: 5,
      ownerWorkspaceId: "ws-owner",
    });
  });
});

describe("agent-registry/caps — isOwnerWorkspace", () => {
  it("is false when no owner workspace is configured", () => {
    expect(isOwnerWorkspace(resolveAgentRegistryCaps({}), "ws-1")).toBe(false);
  });

  it("matches only the configured owner workspace id", () => {
    const caps = resolveAgentRegistryCaps({ ownerWorkspaceId: "ws-owner" });
    expect(isOwnerWorkspace(caps, "ws-owner")).toBe(true);
    expect(isOwnerWorkspace(caps, "ws-other")).toBe(false);
  });
});
