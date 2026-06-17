import { describe, it, expect } from "vitest";
import {
  resolveSkillOptCaps,
  isSkillOptEnabledForWorkspace,
  SKILLOPT_DEFAULTS,
} from "../../src/skillopt/caps.js";

describe("skillopt/caps — resolveSkillOptCaps", () => {
  it("defaults OFF and owner-workspace-first when no config is supplied", () => {
    const caps = resolveSkillOptCaps(undefined);
    expect(caps.enabled).toBe(false);
    expect(caps.ownerWorkspaceOnly).toBe(true);
    expect(caps.ownerWorkspaceId).toBeUndefined();
  });

  it("an empty config block keeps the defaults (a deployment that sets nothing is unchanged)", () => {
    expect(resolveSkillOptCaps({})).toEqual(SKILLOPT_DEFAULTS);
  });

  it("applies supplied overrides", () => {
    const caps = resolveSkillOptCaps({
      enabled: true,
      ownerWorkspaceOnly: false,
      ownerWorkspaceId: "ws-owner",
      minRecurrence: 5,
      minSampleSize: 8,
      minImprovementRatio: 0.1,
      maxAppendChars: 400,
    });
    expect(caps.enabled).toBe(true);
    expect(caps.ownerWorkspaceOnly).toBe(false);
    expect(caps.minRecurrence).toBe(5);
    expect(caps.minSampleSize).toBe(8);
    expect(caps.minImprovementRatio).toBe(0.1);
    expect(caps.maxAppendChars).toBe(400);
  });
});

describe("skillopt/caps — isSkillOptEnabledForWorkspace", () => {
  it("is OFF when the master flag is off", () => {
    expect(isSkillOptEnabledForWorkspace(resolveSkillOptCaps({ enabled: false }), "ws-1")).toBe(false);
  });

  it("enabled without an owner workspace runs for nobody (safest default)", () => {
    expect(isSkillOptEnabledForWorkspace(resolveSkillOptCaps({ enabled: true }), "ws-1")).toBe(false);
  });

  it("enabled + ownerWorkspaceOnly runs only for the named owner workspace", () => {
    const caps = resolveSkillOptCaps({ enabled: true, ownerWorkspaceId: "ws-owner" });
    expect(isSkillOptEnabledForWorkspace(caps, "ws-owner")).toBe(true);
    expect(isSkillOptEnabledForWorkspace(caps, "ws-other")).toBe(false);
  });

  it("ownerWorkspaceOnly=false runs for all tenants once enabled", () => {
    const caps = resolveSkillOptCaps({ enabled: true, ownerWorkspaceOnly: false });
    expect(isSkillOptEnabledForWorkspace(caps, "ws-anything")).toBe(true);
  });
});
