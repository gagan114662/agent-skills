import { describe, it, expect } from "vitest";
import {
  resolveProvisioningCaps,
  isProvisioningEnabledForWorkspace,
  activeProvider,
  PROVISIONING_DEFAULTS,
} from "../../src/provisioning/caps.js";
import { MOCK_PROVIDER } from "../../src/provisioning/registry.js";

const OWNER = "ws-owner";
const OTHER = "ws-other";

/**
 * #267 — default OFF, owner-workspace-first (mirrors delivery/reach). The gate is the master switch this
 * whole feature hangs off: nothing provisions unless it is explicitly turned on AND the workspace is in scope.
 */
describe("provisioning caps", () => {
  it("defaults to OFF, owner-only, no owner id, no provider map", () => {
    const caps = resolveProvisioningCaps(undefined);
    expect(caps).toEqual(PROVISIONING_DEFAULTS);
    expect(caps.enabled).toBe(false);
    expect(isProvisioningEnabledForWorkspace(caps, OWNER)).toBe(false);
  });

  it("empty config object is still fully OFF", () => {
    expect(isProvisioningEnabledForWorkspace(resolveProvisioningCaps({}), OWNER)).toBe(false);
  });

  it("enabled but no owner workspace named ⇒ provisions to NObody (safest default)", () => {
    const caps = resolveProvisioningCaps({ enabled: true });
    expect(isProvisioningEnabledForWorkspace(caps, OWNER)).toBe(false);
    expect(isProvisioningEnabledForWorkspace(caps, OTHER)).toBe(false);
  });

  it("enabled + owner-only ⇒ only the owner workspace is in scope", () => {
    const caps = resolveProvisioningCaps({ enabled: true, ownerWorkspaceId: OWNER });
    expect(isProvisioningEnabledForWorkspace(caps, OWNER)).toBe(true);
    expect(isProvisioningEnabledForWorkspace(caps, OTHER)).toBe(false);
  });

  it("enabled + ownerWorkspaceOnly:false ⇒ every tenant is in scope", () => {
    const caps = resolveProvisioningCaps({
      enabled: true,
      ownerWorkspaceOnly: false,
      ownerWorkspaceId: OWNER,
    });
    expect(isProvisioningEnabledForWorkspace(caps, OWNER)).toBe(true);
    expect(isProvisioningEnabledForWorkspace(caps, OTHER)).toBe(true);
  });

  it("drops blank/whitespace provider ids from the map (treated as not configured)", () => {
    const caps = resolveProvisioningCaps({
      providerByCapability: { keyword_data: "  dataforseo ", serp_data: "   ", social_post: "" },
    });
    expect(caps.providerByCapability).toEqual({ keyword_data: "dataforseo" });
  });

  it("activeProvider returns the mapped provider, else mock, and null for no-central capabilities", () => {
    const caps = resolveProvisioningCaps({ providerByCapability: { keyword_data: "dataforseo" } });
    expect(activeProvider(caps, "keyword_data", true)).toBe("dataforseo");
    expect(activeProvider(caps, "serp_data", true)).toBe(MOCK_PROVIDER);
    expect(activeProvider(caps, "ads_spend", false)).toBeNull();
  });
});
