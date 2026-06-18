import { describe, it, expect } from "vitest";
import {
  ADS_DEFAULTS,
  resolveAdsCaps,
  isAdsEnabledForWorkspace,
  adsPerActionCapCents,
} from "../../src/ads/caps.js";

/**
 * #272 — the ads spend feature flag. Default OFF, owner-workspace-first (mirrors connectOnce/provisioning/
 * delivery), AND a hard per-action money cap that defaults to 0 (no spend can be approved through the agent
 * path until the owner explicitly sets a cap). Two independent OFF switches: the flag and the cap.
 */
describe("ads caps (#272)", () => {
  it("defaults to fully OFF and fail-closed", () => {
    expect(ADS_DEFAULTS.enabled).toBe(false);
    expect(ADS_DEFAULTS.ownerWorkspaceOnly).toBe(true);
    expect(ADS_DEFAULTS.ownerWorkspaceId).toBeNull();
    expect(ADS_DEFAULTS.perActionCapCents).toBe(0);
  });

  it("resolveAdsCaps fills hard defaults from an empty/undefined config", () => {
    expect(resolveAdsCaps(undefined)).toEqual(ADS_DEFAULTS);
    expect(resolveAdsCaps({})).toEqual(ADS_DEFAULTS);
  });

  it("resolveAdsCaps takes explicit config values", () => {
    const caps = resolveAdsCaps({
      enabled: true,
      ownerWorkspaceOnly: false,
      ownerWorkspaceId: "ws-owner",
      perActionCapCents: 50_000,
    });
    expect(caps).toEqual({
      enabled: true,
      ownerWorkspaceOnly: false,
      ownerWorkspaceId: "ws-owner",
      perActionCapCents: 50_000,
    });
  });

  it("is disabled when the flag is off, even for the owner workspace", () => {
    const caps = resolveAdsCaps({ enabled: false, ownerWorkspaceId: "ws-owner" });
    expect(isAdsEnabledForWorkspace(caps, "ws-owner")).toBe(false);
  });

  it("owner-first: only the owner workspace is in scope when enabled", () => {
    const caps = resolveAdsCaps({ enabled: true, ownerWorkspaceId: "ws-owner" });
    expect(isAdsEnabledForWorkspace(caps, "ws-owner")).toBe(true);
    expect(isAdsEnabledForWorkspace(caps, "ws-other")).toBe(false);
  });

  it("fail-closed: an unset owner id lets NOBODY in (never everybody)", () => {
    const caps = resolveAdsCaps({ enabled: true, ownerWorkspaceOnly: true });
    expect(isAdsEnabledForWorkspace(caps, "ws-anyone")).toBe(false);
  });

  it("broadens to all tenants only when ownerWorkspaceOnly is explicitly false", () => {
    const caps = resolveAdsCaps({ enabled: true, ownerWorkspaceOnly: false });
    expect(isAdsEnabledForWorkspace(caps, "ws-anyone")).toBe(true);
  });

  it("adsPerActionCapCents clamps to a non-negative integer", () => {
    expect(adsPerActionCapCents(resolveAdsCaps({ perActionCapCents: 12_345 }))).toBe(12_345);
    expect(adsPerActionCapCents(resolveAdsCaps({ perActionCapCents: -5 }))).toBe(0);
    expect(adsPerActionCapCents(resolveAdsCaps({ perActionCapCents: 99.9 }))).toBe(99);
    expect(adsPerActionCapCents(resolveAdsCaps({}))).toBe(0);
  });
});
