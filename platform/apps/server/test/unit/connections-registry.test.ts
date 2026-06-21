import { describe, it, expect } from "vitest";
import {
  CONNECTION_DESCRIPTORS,
  EMAIL_CONNECTION_ID,
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

  it("NO customer-facing connector ever asks the customer to paste a credential", () => {
    const customer = listConnectionDescriptors({ audience: "customer" });
    expect(customer.length).toBeGreaterThan(0);
    for (const d of customer) {
      // Customers connect via consumer OAuth or a one-click consent — never a paste-a-token (that path is
      // INTERNAL/admin only). And a customer connector never carries env-key secret slots.
      expect(d.auth, `${d.id} must not be paste_internal`).not.toBe("paste_internal");
      expect(d.auth === "oauth" || d.auth === "one_click", `${d.id} must be oauth|one_click`).toBe(true);
      expect(d.envKeys, `${d.id} must seal no customer secret`).toEqual([]);
    }
  });

  it("surfaces outbound email as an AVAILABLE one-click customer connector (#529/#507)", () => {
    // The dead-end fix: a fresh workspace can finish the "connect an account" step because email is live.
    const email = getConnectionDescriptor(EMAIL_CONNECTION_ID);
    expect(email?.audience).toBe("customer");
    expect(email?.auth).toBe("one_click");
    expect(email?.status).toBe("available");
    expect(email?.capabilities).toContain("send_email");
    expect(email?.oauthScopes).toEqual([]);
    expect(email?.envKeys).toEqual([]);
  });

  it("at least one customer connector is actually available (no all-coming-soon dead-end)", () => {
    const available = listConnectionDescriptors({ audience: "customer" }).filter((d) => d.status === "available");
    expect(available.length).toBeGreaterThan(0);
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

  it("models the #269 connect-once social AGGREGATOR as one customer OAuth consent (multi-network fan-out)", () => {
    const d = getConnectionDescriptor("social_aggregator");
    expect(d?.audience).toBe("customer");
    expect(d?.auth).toBe("oauth");
    expect(d?.capabilities).toContain("post_social");
    // a customer never sees a per-platform developer-portal token
    expect(d?.envKeys).toEqual([]);
  });

  it("listConnectionDescriptors filters by audience", () => {
    const internal = listConnectionDescriptors({ audience: "internal" });
    expect(internal.every((d) => d.audience === "internal")).toBe(true);
    expect(internal.map((d) => d.id)).toContain(SITE_PUBLISH_GITHUB_ID);
  });
});
