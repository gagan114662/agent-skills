import { describe, it, expect } from "vitest";
import {
  CONNECTION_DESCRIPTORS,
  getConnectionDescriptor,
  listConnectionDescriptors,
} from "../../src/connections/registry.js";
import { hasConnectedCapability } from "../../src/connections/capabilities.js";

/**
 * #272 — Bid's one-click ad account connect REUSES the connect-once seam (#258): a single customer-facing
 * OAuth connector whose one consent unlocks the `ads` capability Bid gates its work on. No new connect
 * machinery — just the descriptor + the existing capability gate.
 */
describe("google_ads connector (#272)", () => {
  it("is a customer-facing OAuth ad-account connector unlocking the `ads` capability", () => {
    const d = getConnectionDescriptor("google_ads");
    expect(d).toBeDefined();
    expect(d?.audience).toBe("customer");
    expect(d?.auth).toBe("oauth");
    expect(d?.kind).toBe("ad_account");
    expect(d?.capabilities).toContain("ads");
    expect(d?.oauthScopes.length).toBeGreaterThan(0);
  });

  it("renders as a customer connector (one-click, no paste)", () => {
    const customer = listConnectionDescriptors({ audience: "customer" });
    expect(customer.map((c) => c.id)).toContain("google_ads");
  });

  it("seals no env keys (a customer never pastes a token)", () => {
    expect(getConnectionDescriptor("google_ads")?.envKeys).toEqual([]);
  });

  it("Bid's `ads` gate is closed until the account is connected, open once it is", () => {
    const ask = (connectedIds: Set<string>) =>
      hasConnectedCapability({ descriptors: CONNECTION_DESCRIPTORS, connectedIds, capability: "ads" });
    expect(ask(new Set())).toBe(false);
    expect(ask(new Set(["google"]))).toBe(false); // a different connection does not unlock ads
    expect(ask(new Set(["google_ads"]))).toBe(true);
  });
});
