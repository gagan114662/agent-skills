import { describe, it, expect } from "vitest";
import {
  resolveGardenCaps,
  isOwnerWorkspace,
  isGardenManageInScope,
  GARDEN_DEFAULTS,
} from "../../src/garden/caps.js";

describe("garden/caps — resolveGardenCaps", () => {
  it("defaults OFF and owner-workspace-first when no config is supplied", () => {
    const caps = resolveGardenCaps(undefined);
    expect(caps.enabled).toBe(false);
    expect(caps.ownerWorkspaceOnly).toBe(true);
    expect(caps.ownerWorkspaceId).toBeNull();
  });

  it("an empty config block keeps the defaults (a deployment that sets nothing is unchanged)", () => {
    expect(resolveGardenCaps({})).toEqual(GARDEN_DEFAULTS);
  });

  it("applies the supplied overrides", () => {
    expect(resolveGardenCaps({ enabled: true, ownerWorkspaceOnly: false, ownerWorkspaceId: "ws-owner" })).toEqual({
      enabled: true,
      ownerWorkspaceOnly: false,
      ownerWorkspaceId: "ws-owner",
    });
  });
});

describe("garden/caps — isOwnerWorkspace", () => {
  it("is false when no owner workspace is configured", () => {
    expect(isOwnerWorkspace(resolveGardenCaps({}), "ws-1")).toBe(false);
  });

  it("matches only the configured owner workspace id", () => {
    const caps = resolveGardenCaps({ ownerWorkspaceId: "ws-owner" });
    expect(isOwnerWorkspace(caps, "ws-owner")).toBe(true);
    expect(isOwnerWorkspace(caps, "ws-other")).toBe(false);
  });
});

describe("garden/caps — isGardenManageInScope", () => {
  it("is false when the flag is off (catalog still lists, but nothing can be managed)", () => {
    expect(isGardenManageInScope(resolveGardenCaps({ enabled: false }), "ws-owner")).toBe(false);
  });

  it("owner-first: only the owner workspace may manage while ownerWorkspaceOnly is on", () => {
    const caps = resolveGardenCaps({ enabled: true, ownerWorkspaceId: "ws-owner" });
    expect(isGardenManageInScope(caps, "ws-owner")).toBe(true);
    expect(isGardenManageInScope(caps, "ws-other")).toBe(false);
  });

  it("any workspace may manage once owner-first is lifted", () => {
    const caps = resolveGardenCaps({ enabled: true, ownerWorkspaceOnly: false, ownerWorkspaceId: "ws-owner" });
    expect(isGardenManageInScope(caps, "ws-other")).toBe(true);
  });
});
