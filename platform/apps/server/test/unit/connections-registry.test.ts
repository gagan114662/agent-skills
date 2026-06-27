import { describe, it, expect } from "vitest";
import {
  CONNECTION_DESCRIPTORS,
  EMAIL_CONNECTION_ID,
  getConnectionDescriptor,
  listConnectionDescriptors,
  SOCIAL_AGGREGATOR_ID,
  SITE_PUBLISH_GITHUB_ID,
  TELEGRAM_ROOM_CONNECTION_ID,
  WEB_ROOM_CONNECTION_ID,
  WEBSITE_CONNECTION_ID,
  WHATSAPP_ROOM_CONNECTION_ID,
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

  it("surfaces onboarding's three payoff connectors as AVAILABLE one-click customer consents (#1070)", () => {
    for (const [id, capability] of [
      [EMAIL_CONNECTION_ID, "send_email"],
      [SOCIAL_AGGREGATOR_ID, "post_social"],
      [WEBSITE_CONNECTION_ID, "site_publish"],
    ] as const) {
      const descriptor = getConnectionDescriptor(id);
      expect(descriptor?.audience, id).toBe("customer");
      expect(descriptor?.auth, id).toBe("one_click");
      expect(descriptor?.status, id).toBe("available");
      expect(descriptor?.capabilities, id).toContain(capability);
      expect(descriptor?.oauthScopes, id).toEqual([]);
      expect(descriptor?.envKeys, id).toEqual([]);
    }
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
    const website = getConnectionDescriptor(WEBSITE_CONNECTION_ID);
    expect(website?.audience).toBe("customer");
    expect(website?.auth).toBe("one_click");
    expect(website?.status).toBe("available");
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

  it("models the #269/#1070 connect-once social AGGREGATOR as one customer consent", () => {
    const d = getConnectionDescriptor(SOCIAL_AGGREGATOR_ID);
    expect(d?.audience).toBe("customer");
    expect(d?.auth).toBe("one_click");
    expect(d?.status).toBe("available");
    expect(d?.capabilities).toContain("post_social");
    // a customer never sees a per-platform developer-portal token
    expect(d?.envKeys).toEqual([]);
  });

  it("keeps unavailable customer connectors visibly explained", () => {
    const customer = listConnectionDescriptors({ audience: "customer" });
    for (const d of customer.filter((descriptor) => descriptor.status !== "available")) {
      expect(d.statusReason, `${d.id} must explain why it is not live`).toEqual(expect.any(String));
      expect(d.statusReason?.trim().length).toBeGreaterThan(0);
    }
  });

  it("models iMessage room visibility as blocked until a signed Mac relay exists", () => {
    const d = getConnectionDescriptor("imessage_room");
    expect(d?.audience).toBe("customer");
    expect(d?.auth).toBe("oauth");
    expect(d?.status).toBe("blocked");
    expect(d?.capabilities).toEqual(expect.arrayContaining(["agent_room_visibility", "inbound_replies"]));
    expect(d?.statusReason).toMatch(/signed Mac relay host/i);
    expect(d?.statusReason).toMatch(/Fly cannot run Apple Messages/i);
  });

  it("surfaces web, WhatsApp, and Telegram room visibility without faking live transports (#1267)", () => {
    const web = getConnectionDescriptor(WEB_ROOM_CONNECTION_ID);
    expect(web?.audience).toBe("customer");
    expect(web?.auth).toBe("one_click");
    expect(web?.status).toBe("available");
    expect(web?.capabilities).toEqual(
      expect.arrayContaining(["work_visibility", "agent_room_visibility", "inbound_replies"]),
    );
    expect(web?.oauthScopes).toEqual([]);
    expect(web?.envKeys).toEqual([]);

    for (const id of [WHATSAPP_ROOM_CONNECTION_ID, TELEGRAM_ROOM_CONNECTION_ID]) {
      const descriptor = getConnectionDescriptor(id);
      expect(descriptor?.audience, id).toBe("customer");
      expect(descriptor?.auth, id).toBe("one_click");
      expect(descriptor?.status, id).toBe("coming_soon");
      expect(descriptor?.statusReason?.trim().length, id).toBeGreaterThan(0);
      expect(descriptor?.capabilities, id).toEqual(
        expect.arrayContaining(["work_visibility", "mobile_messaging", "agent_room_visibility", "inbound_replies"]),
      );
      expect(descriptor?.oauthScopes, id).toEqual([]);
      expect(descriptor?.envKeys, id).toEqual([]);
    }
  });

  it("listConnectionDescriptors filters by audience", () => {
    const internal = listConnectionDescriptors({ audience: "internal" });
    expect(internal.every((d) => d.audience === "internal")).toBe(true);
    expect(internal.map((d) => d.id)).toContain(SITE_PUBLISH_GITHUB_ID);
  });
});
