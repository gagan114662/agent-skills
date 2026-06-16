import { describe, it, expect } from "vitest";
import {
  CONNECTION_DESCRIPTORS,
  getConnectionDescriptor,
  listConnectionDescriptors,
  SITE_PUBLISH_GITHUB_ID,
} from "../../src/connections/registry.js";

/**
 * #258 — the OAuth-first connection model. ipop's customers are non-technical: every customer-facing
 * connector is a consumer OAuth ("Sign in with Google", "Connect X"), never a paste-a-token. The only
 * paste path is the INTERNAL GitHub site-publish mechanism (ipop.ai's own publishing), which is admin/
 * internal and never offered to a customer.
 */
describe("connection registry (#258)", () => {
  it("has unique ids", () => {
    const ids = CONNECTION_DESCRIPTORS.map((d) => d.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("the GitHub site-publish connector is INTERNAL, paste-only, and available", () => {
    const gh = getConnectionDescriptor(SITE_PUBLISH_GITHUB_ID);
    expect(gh).toBeDefined();
    expect(gh?.audience).toBe("internal");
    expect(gh?.auth).toBe("paste_internal");
    expect(gh?.status).toBe("available");
    expect(gh?.envKeys).toContain("REALWORLD_GITHUB_TOKEN");
    expect(gh?.envKeys).toContain("REALWORLD_SITE_REPO");
  });

  it("EVERY customer-facing connector is OAuth-shaped (never paste)", () => {
    const customer = listConnectionDescriptors({ audience: "customer" });
    expect(customer.length).toBeGreaterThan(0);
    for (const d of customer) {
      expect(d.auth, `${d.id} must be oauth`).toBe("oauth");
    }
  });

  it("models 'Sign in with Google' as one consent covering Search Console + Analytics", () => {
    const google = getConnectionDescriptor("google");
    expect(google?.audience).toBe("customer");
    expect(google?.auth).toBe("oauth");
    expect(google?.capabilities).toEqual(expect.arrayContaining(["search_console", "analytics"]));
    expect(google?.oauthScopes.length).toBeGreaterThan(0);
  });

  it("offers customer publishing as 'Connect your website' (no repo, no GitHub)", () => {
    const website = getConnectionDescriptor("website");
    expect(website?.audience).toBe("customer");
    expect(website?.capabilities).toContain("site_publish");
    // a customer must never be shown the GitHub repo/token path
    expect(website?.envKeys).not.toContain("REALWORLD_GITHUB_TOKEN");
  });

  it("models X and LinkedIn as connect-once social OAuth", () => {
    for (const id of ["x", "linkedin"]) {
      const d = getConnectionDescriptor(id);
      expect(d?.audience).toBe("customer");
      expect(d?.auth).toBe("oauth");
      expect(d?.capabilities).toContain("post_social");
    }
  });

  it("listConnectionDescriptors filters by audience", () => {
    const internal = listConnectionDescriptors({ audience: "internal" });
    expect(internal.every((d) => d.audience === "internal")).toBe(true);
    expect(internal.map((d) => d.id)).toContain(SITE_PUBLISH_GITHUB_ID);
  });
});
