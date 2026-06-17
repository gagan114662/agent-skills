import { describe, it, expect } from "vitest";
import {
  resolveVentureCaps,
  isVentureGateEnabledForWorkspace,
  VENTURE_DEFAULTS,
  type VentureCaps,
} from "../../src/venture/caps.js";

describe("resolveVentureCaps (#228 owner-first defaults)", () => {
  it("defaults the gate OFF, owner-workspace-first, with no owner named", () => {
    const caps = resolveVentureCaps(undefined);
    expect(caps.enabled).toBe(false);
    expect(caps.ownerWorkspaceOnly).toBe(true);
    expect(caps.ownerWorkspaceId).toBeUndefined();
  });

  it("carries through the owner-first overrides from config", () => {
    const caps = resolveVentureCaps({
      enabled: true,
      ownerWorkspaceOnly: false,
      ownerWorkspaceId: "ws-owner",
    });
    expect(caps.enabled).toBe(true);
    expect(caps.ownerWorkspaceOnly).toBe(false);
    expect(caps.ownerWorkspaceId).toBe("ws-owner");
  });
});

describe("isVentureGateEnabledForWorkspace (#228, pure)", () => {
  function caps(over: Partial<VentureCaps>): VentureCaps {
    return { ...VENTURE_DEFAULTS, ...over };
  }

  it("never enforces when the master flag is off (today's behavior for everyone)", () => {
    const c = caps({ enabled: false, ownerWorkspaceId: "ws-owner", ownerWorkspaceOnly: true });
    expect(isVentureGateEnabledForWorkspace(c, "ws-owner")).toBe(false);
    expect(isVentureGateEnabledForWorkspace(c, "ws-other")).toBe(false);
  });

  it("enabled + ownerWorkspaceOnly enforces ONLY on the named owner workspace", () => {
    const c = caps({ enabled: true, ownerWorkspaceOnly: true, ownerWorkspaceId: "ws-owner" });
    expect(isVentureGateEnabledForWorkspace(c, "ws-owner")).toBe(true);
    expect(isVentureGateEnabledForWorkspace(c, "ws-other")).toBe(false);
  });

  it("enabled WITHOUT naming an owner enforces on nobody (the safest default)", () => {
    const c = caps({ enabled: true, ownerWorkspaceOnly: true, ownerWorkspaceId: undefined });
    expect(isVentureGateEnabledForWorkspace(c, "ws-owner")).toBe(false);
    expect(isVentureGateEnabledForWorkspace(c, "anything")).toBe(false);
  });

  it("enabled + ownerWorkspaceOnly=false enforces on every tenant (broad rollout)", () => {
    const c = caps({ enabled: true, ownerWorkspaceOnly: false, ownerWorkspaceId: "ws-owner" });
    expect(isVentureGateEnabledForWorkspace(c, "ws-owner")).toBe(true);
    expect(isVentureGateEnabledForWorkspace(c, "ws-other")).toBe(true);
  });
});
