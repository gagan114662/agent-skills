import { describe, it, expect } from "vitest";
import {
  resolveAcquisitionCaps,
  ACQUISITION_DEFAULTS,
  channelExecutes,
  isOwnerWorkspace,
} from "../../src/acquisition/caps.js";

describe("resolveAcquisitionCaps", () => {
  it("defaults everything OFF (recorded-only stays the behavior)", () => {
    const caps = resolveAcquisitionCaps(undefined);
    expect(caps.enabled).toBe(false);
    expect(caps.channels).toEqual({ ads: false, email: false, social: false, seo: false });
    expect(caps.autoSend).toBe(false);
    expect(caps.adsProvider).toBe("dryrun");
    expect(caps.espProvider).toBe("dryrun");
    expect(caps.socialProvider).toBe("dryrun");
  });

  it("an empty block resolves to the defaults", () => {
    expect(resolveAcquisitionCaps({})).toEqual(ACQUISITION_DEFAULTS);
  });

  it("applies overrides", () => {
    const caps = resolveAcquisitionCaps({
      enabled: true,
      ads: true,
      email: true,
      autoSend: true,
      ownerWorkspaceId: "ws-1",
      emailWindowCap: 25,
    });
    expect(caps.enabled).toBe(true);
    expect(caps.channels.ads).toBe(true);
    expect(caps.channels.email).toBe(true);
    expect(caps.channels.social).toBe(false);
    expect(caps.autoSend).toBe(true);
    expect(caps.emailWindowCap).toBe(25);
  });
});

describe("channelExecutes", () => {
  it("requires BOTH the master flag and the channel flag", () => {
    expect(channelExecutes(resolveAcquisitionCaps({ enabled: false, ads: true }), "ads")).toBe(false);
    expect(channelExecutes(resolveAcquisitionCaps({ enabled: true, ads: false }), "ads")).toBe(false);
    expect(channelExecutes(resolveAcquisitionCaps({ enabled: true, ads: true }), "ads")).toBe(true);
  });
});

describe("isOwnerWorkspace", () => {
  it("matches only the configured owner workspace", () => {
    const caps = resolveAcquisitionCaps({ ownerWorkspaceId: "ws-owner" });
    expect(isOwnerWorkspace(caps, "ws-owner")).toBe(true);
    expect(isOwnerWorkspace(caps, "ws-other")).toBe(false);
    expect(isOwnerWorkspace(resolveAcquisitionCaps({}), "ws-owner")).toBe(false);
  });
});
