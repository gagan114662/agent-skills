import { describe, expect, it } from "vitest";
import {
  FIRST_DOLLAR_GTM_WEDGE,
  firstDollarMetricReached,
  firstDollarReachPlan,
  firstDollarTrackingRef,
} from "../../../src/gtm/first-dollar-wedge.js";

describe("first-dollar GTM wedge (#396)", () => {
  it("names a narrow first buyer and an urgent revenue job", () => {
    expect(FIRST_DOLLAR_GTM_WEDGE.buyer.segment).toBe("b2b_founder");
    expect(FIRST_DOLLAR_GTM_WEDGE.buyer.teamSize).toBe("1_20");
    expect(FIRST_DOLLAR_GTM_WEDGE.buyer.roleTitles).toContain("founder");
    expect(FIRST_DOLLAR_GTM_WEDGE.buyer.urgentJob).toMatch(/this week/i);
    expect(FIRST_DOLLAR_GTM_WEDGE.buyer.disqualifiers).toContain("enterprise procurement cycle");
  });

  it("keeps direct outbound blocked until the live channel issue is solved", () => {
    expect(FIRST_DOLLAR_GTM_WEDGE.reach.liveChannelDependencyIssue).toBe(395);
    expect(firstDollarReachPlan(false)).toEqual(["build_in_public_post", "warm_founder_dm"]);
    expect(firstDollarReachPlan(false)).not.toContain("email_with_checkout_ref");
    expect(firstDollarReachPlan(true)[0]).toBe("email_with_checkout_ref");
  });

  it("uses one external Stripe-checkout attempt in seven days as the success metric", () => {
    expect(FIRST_DOLLAR_GTM_WEDGE.successMetric).toEqual({
      windowDays: 7,
      event: "external_signup_reaches_stripe_checkout",
      minimumCount: 1,
      attributionRefPrefix: "ipop-first-dollar-",
    });
    expect(firstDollarMetricReached([{ event: "external_signup_reaches_stripe_checkout", external: false }])).toBe(
      false,
    );
    expect(firstDollarMetricReached([{ event: "external_signup_reaches_stripe_checkout", external: true }])).toBe(
      true,
    );
  });

  it("creates stable checkout tracking refs without leaking arbitrary punctuation", () => {
    expect(firstDollarTrackingRef(" Founder / Acme.io launch! ")).toBe(
      "ipop-first-dollar-founder-acme-io-launch",
    );
    expect(firstDollarTrackingRef("!!!")).toBe("ipop-first-dollar-unknown");
  });
});
