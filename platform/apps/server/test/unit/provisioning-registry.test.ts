import { describe, it, expect } from "vitest";
import {
  CAPABILITY_DESCRIPTORS,
  getCapabilityDescriptor,
  listCapabilityDescriptors,
  isCustomerSpendCapability,
  centralServiceKey,
  MOCK_PROVIDER,
} from "../../src/provisioning/registry.js";

/**
 * #267 — the central provisioning catalog. It is pure data + selectors; the invariants we protect:
 *  - every capability has a cost class; the customer-spend ones are the only money-gated ones,
 *  - a platform-cost capability always offers the free `mock` provider (so the OFF default resolves),
 *  - the central vault key is namespaced so it can never collide with a customer paste.
 */
describe("provisioning registry", () => {
  it("exposes a non-empty catalog with stable, unique ids", () => {
    expect(CAPABILITY_DESCRIPTORS.length).toBeGreaterThan(0);
    const ids = CAPABILITY_DESCRIPTORS.map((d) => d.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("classifies the customer's own spend (ad budget, email tier) as customer_spend", () => {
    expect(isCustomerSpendCapability("ads_spend")).toBe(true);
    expect(isCustomerSpendCapability("email_send_tier")).toBe(true);
  });

  it("classifies real keyword/SERP/social/ads-management data as platform_cost", () => {
    for (const id of ["keyword_data", "serp_data", "social_post", "ads_manage"]) {
      expect(getCapabilityDescriptor(id)?.costClass).toBe("platform_cost");
      expect(isCustomerSpendCapability(id)).toBe(false);
    }
  });

  it("every platform_cost capability offers the free mock provider; customer_spend has none", () => {
    for (const d of CAPABILITY_DESCRIPTORS) {
      if (d.costClass === "platform_cost") {
        expect(d.providers).toContain(MOCK_PROVIDER);
      } else {
        expect(d.providers).toHaveLength(0);
      }
    }
  });

  it("filters by cost class", () => {
    const customer = listCapabilityDescriptors({ costClass: "customer_spend" });
    expect(customer.every((d) => d.costClass === "customer_spend")).toBe(true);
    expect(customer.length).toBeGreaterThan(0);
  });

  it("returns undefined for an unknown capability (callers fail closed)", () => {
    expect(getCapabilityDescriptor("nope")).toBeUndefined();
    expect(isCustomerSpendCapability("nope")).toBe(false);
  });

  it("namespaces the central vault key under `central:` so it can't collide with a customer key", () => {
    expect(centralServiceKey("dataforseo")).toBe("central:dataforseo");
    expect(centralServiceKey(MOCK_PROVIDER)).toBe("central:mock");
  });
});
