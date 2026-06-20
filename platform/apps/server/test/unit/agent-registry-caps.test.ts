import { describe, it, expect } from "vitest";
import {
  resolveAgentRegistryCaps,
  isOwnerWorkspace,
  AGENT_REGISTRY_DEFAULTS,
} from "../../src/agent-registry/caps.js";
import { loadConfig } from "../../src/config/loader.js";

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

describe("agent-registry/caps — owner-ws env fallback (#417 regression)", () => {
  // The prod bug: RELOAD_AGENT_REGISTRY_ENABLED=true with no dedicated owner var left ownerWorkspaceId
  // undefined → isOwnerWorkspace false → every agent enabled:false → every A2A handoff denied. The loader
  // must fall back to RELOAD_MARKETING_OWNER_WORKSPACE_ID like every other owner-first feature.
  it("falls back to RELOAD_MARKETING_OWNER_WORKSPACE_ID when the dedicated owner var is unset", () => {
    const cfg = loadConfig("owner-ws", {
      env: { RELOAD_AGENT_REGISTRY_ENABLED: "true", RELOAD_MARKETING_OWNER_WORKSPACE_ID: "owner-ws" },
      readFile: () => undefined,
    });
    const caps = resolveAgentRegistryCaps(cfg.agentRegistry);
    expect(caps.enabled).toBe(true);
    expect(caps.ownerWorkspaceId).toBe("owner-ws");
    // The owner workspace is now correctly recognized → A2A entries enable for it.
    expect(isOwnerWorkspace(caps, "owner-ws")).toBe(true);
    expect(isOwnerWorkspace(caps, "customer-ws")).toBe(false);
  });

  it("a dedicated RELOAD_AGENT_REGISTRY_OWNER_WORKSPACE_ID still overrides the marketing fallback", () => {
    const cfg = loadConfig("reg-owner", {
      env: {
        RELOAD_AGENT_REGISTRY_ENABLED: "true",
        RELOAD_AGENT_REGISTRY_OWNER_WORKSPACE_ID: "reg-owner",
        RELOAD_MARKETING_OWNER_WORKSPACE_ID: "mkt-owner",
      },
      readFile: () => undefined,
    });
    const caps = resolveAgentRegistryCaps(cfg.agentRegistry);
    expect(caps.ownerWorkspaceId).toBe("reg-owner");
  });
});
