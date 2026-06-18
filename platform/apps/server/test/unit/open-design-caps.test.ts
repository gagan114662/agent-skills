import { describe, it, expect } from "vitest";
import {
  resolveOpenDesignCaps,
  isOpenDesignEnabledForWorkspace,
  OPEN_DESIGN_DEFAULTS,
} from "../../src/open-design/caps.js";

describe("open-design/caps — resolveOpenDesignCaps", () => {
  it("defaults OFF and owner-workspace-first when no config is supplied", () => {
    const caps = resolveOpenDesignCaps(undefined);
    expect(caps.enabled).toBe(false);
    expect(caps.ownerWorkspaceOnly).toBe(true);
    expect(caps.ownerWorkspaceId).toBeUndefined();
  });

  it("an empty config block keeps the defaults (a deployment that sets nothing is unchanged)", () => {
    expect(resolveOpenDesignCaps({})).toEqual(OPEN_DESIGN_DEFAULTS);
  });

  it("applies the supplied overrides", () => {
    expect(
      resolveOpenDesignCaps({ enabled: true, ownerWorkspaceOnly: false, ownerWorkspaceId: "ws-owner" }),
    ).toEqual({
      enabled: true,
      ownerWorkspaceOnly: false,
      ownerWorkspaceId: "ws-owner",
    });
  });
});

describe("open-design/caps — isOpenDesignEnabledForWorkspace", () => {
  it("is false when the flag is off (fail-closed — the default)", () => {
    expect(isOpenDesignEnabledForWorkspace(resolveOpenDesignCaps({ enabled: false }), "ws-owner")).toBe(false);
  });

  it("enabled but no owner workspace named → offers to nobody (safest default)", () => {
    expect(isOpenDesignEnabledForWorkspace(resolveOpenDesignCaps({ enabled: true }), "ws-1")).toBe(false);
  });

  it("owner-first: only the owner workspace is offered while ownerWorkspaceOnly is on", () => {
    const caps = resolveOpenDesignCaps({ enabled: true, ownerWorkspaceId: "ws-owner" });
    expect(isOpenDesignEnabledForWorkspace(caps, "ws-owner")).toBe(true);
    expect(isOpenDesignEnabledForWorkspace(caps, "ws-other")).toBe(false);
  });

  it("any workspace is offered once owner-first is lifted", () => {
    const caps = resolveOpenDesignCaps({ enabled: true, ownerWorkspaceOnly: false, ownerWorkspaceId: "ws-owner" });
    expect(isOpenDesignEnabledForWorkspace(caps, "ws-other")).toBe(true);
  });
});
