import { describe, it, expect } from "vitest";
import { resolveSiteUrl, IPOP_SITE_URL } from "../../src/marketing/site.js";

describe("resolveSiteUrl (#250)", () => {
  it("returns a configured site URL verbatim when it already has a scheme", () => {
    expect(resolveSiteUrl({ workspaceId: "w1", configuredSiteUrl: "https://acme.com" })).toBe("https://acme.com");
  });

  it("adds https:// to a bare configured host so it is a fetchable URL", () => {
    expect(resolveSiteUrl({ workspaceId: "w1", configuredSiteUrl: "acme.com" })).toBe("https://acme.com");
    expect(resolveSiteUrl({ workspaceId: "w1", configuredSiteUrl: "  acme.com  " })).toBe("https://acme.com");
  });

  it("a configured URL wins over the owner-workspace ipop.ai fallback", () => {
    expect(
      resolveSiteUrl({ workspaceId: "ipop", ownerWorkspaceId: "ipop", configuredSiteUrl: "https://acme.com" }),
    ).toBe("https://acme.com");
  });

  it("falls back to ipop.ai for the owner's OWN workspace when nothing is configured", () => {
    expect(resolveSiteUrl({ workspaceId: "ipop", ownerWorkspaceId: "ipop" })).toBe(IPOP_SITE_URL);
    expect(IPOP_SITE_URL).toBe("https://ipop.ai");
  });

  it("returns undefined for a non-owner workspace with nothing configured (never invents a domain)", () => {
    expect(resolveSiteUrl({ workspaceId: "w1", ownerWorkspaceId: "ipop" })).toBeUndefined();
    expect(resolveSiteUrl({ workspaceId: "w1" })).toBeUndefined();
    expect(resolveSiteUrl({ workspaceId: "w1", configuredSiteUrl: "   " })).toBeUndefined();
  });
});
