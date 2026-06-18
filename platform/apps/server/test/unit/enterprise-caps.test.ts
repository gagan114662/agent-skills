import { describe, it, expect } from "vitest";
import {
  resolveEnterpriseCaps,
  isEnterpriseEnabledForWorkspace,
  isPassportEnabledForWorkspace,
  ENTERPRISE_DEFAULTS,
} from "../../src/enterprise/caps.js";

describe("enterprise caps — default OFF, owner-workspace-first (#340, #200)", () => {
  it("a deployment that sets nothing is fully OFF (metering + enforcement + passport)", () => {
    const caps = resolveEnterpriseCaps(undefined);
    expect(caps.enabled).toBe(false);
    expect(caps.passportEnabled).toBe(false);
    expect(caps.ownerWorkspaceOnly).toBe(true);
    expect(isEnterpriseEnabledForWorkspace(caps, "ws_any")).toBe(false);
    expect(isPassportEnabledForWorkspace(caps, "ws_any")).toBe(false);
  });

  it("enabling WITHOUT naming the owner workspace enforces on NObody (safest default)", () => {
    const caps = resolveEnterpriseCaps({ enabled: true });
    expect(isEnterpriseEnabledForWorkspace(caps, "ws_1")).toBe(false);
  });

  it("enabled + owner-only is active ONLY for the named owner workspace", () => {
    const caps = resolveEnterpriseCaps({ enabled: true, ownerWorkspaceId: "ws_owner" });
    expect(isEnterpriseEnabledForWorkspace(caps, "ws_owner")).toBe(true);
    expect(isEnterpriseEnabledForWorkspace(caps, "ws_other")).toBe(false);
  });

  it("ownerWorkspaceOnly=false broadens enablement to all tenants", () => {
    const caps = resolveEnterpriseCaps({ enabled: true, ownerWorkspaceOnly: false });
    expect(isEnterpriseEnabledForWorkspace(caps, "ws_anything")).toBe(true);
  });

  it("the passport gate requires the master flag on AND its own flag AND the workspace in scope", () => {
    const onlyMaster = resolveEnterpriseCaps({ enabled: true, ownerWorkspaceId: "ws_owner" });
    expect(isPassportEnabledForWorkspace(onlyMaster, "ws_owner")).toBe(false); // passport flag still off
    const both = resolveEnterpriseCaps({
      enabled: true,
      passportEnabled: true,
      ownerWorkspaceId: "ws_owner",
    });
    expect(isPassportEnabledForWorkspace(both, "ws_owner")).toBe(true);
    expect(isPassportEnabledForWorkspace(both, "ws_other")).toBe(false);
  });

  it("normalizes the IdP allow-list (trim, lower-case, drop blanks) and keeps numeric defaults", () => {
    const caps = resolveEnterpriseCaps({ allowedIdpProviders: ["  Google ", "", "OKTA"] });
    expect(caps.allowedIdpProviders).toEqual(["google", "okta"]);
    expect(caps.usageListLimit).toBe(ENTERPRISE_DEFAULTS.usageListLimit);
  });

  it("clamps negative / non-finite default cap cents to null (no implicit cap)", () => {
    const caps = resolveEnterpriseCaps({ defaultAgentCapCents: -5, defaultCustomerCapCents: 50_000 });
    expect(caps.defaultAgentCapCents).toBeNull();
    expect(caps.defaultCustomerCapCents).toBe(50_000);
  });
});
