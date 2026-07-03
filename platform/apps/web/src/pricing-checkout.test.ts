/**
 * Unit guard for the #1550 checkout resolver — the safety edges the page test can't see:
 * only a real `buy.stripe.com` link is honoured, the interval picks the right link, and anything
 * missing/malformed falls back to `/signup` rather than routing money at an unexpected host.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  hasStripePaymentLink,
  isStripePaymentLink,
  planCheckoutHref,
  signupFallbackHref,
} from "./pricing-checkout.js";

afterEach(() => vi.unstubAllEnvs());

describe("isStripePaymentLink", () => {
  it("accepts only absolute https buy.stripe.com URLs", () => {
    expect(isStripePaymentLink("https://buy.stripe.com/abc123")).toBe(true);
    // Reject everything that isn't a real hosted Stripe Payment Link.
    expect(isStripePaymentLink(undefined)).toBe(false);
    expect(isStripePaymentLink("")).toBe(false);
    expect(isStripePaymentLink("/signup?plan=pro")).toBe(false);
    expect(isStripePaymentLink("http://buy.stripe.com/abc")).toBe(false); // not https
    expect(isStripePaymentLink("https://evil.example.com/buy.stripe.com")).toBe(false);
    expect(isStripePaymentLink("https://dashboard.stripe.com/abc")).toBe(false);
    expect(isStripePaymentLink("not a url")).toBe(false);
  });
});

describe("planCheckoutHref", () => {
  it("falls back to the /signup hand-off when nothing is configured", () => {
    expect(planCheckoutHref("pro", "month")).toBe(signupFallbackHref("pro", "month"));
    expect(planCheckoutHref("pro", "month")).toBe("/signup?plan=pro&billing=month");
    expect(hasStripePaymentLink("pro", "month")).toBe(false);
  });

  it("returns the configured buy.stripe.com link for the chosen interval", () => {
    vi.stubEnv("VITE_STRIPE_PAYMENT_LINK_PRO_MONTH", "https://buy.stripe.com/pro_m");
    vi.stubEnv("VITE_STRIPE_PAYMENT_LINK_PRO_YEAR", "https://buy.stripe.com/pro_y");
    expect(planCheckoutHref("pro", "month")).toBe("https://buy.stripe.com/pro_m");
    expect(planCheckoutHref("pro", "year")).toBe("https://buy.stripe.com/pro_y");
    expect(hasStripePaymentLink("pro", "year")).toBe(true);
  });

  it("uses the interval-agnostic link as a fallback when no per-interval link is set", () => {
    vi.stubEnv("VITE_STRIPE_PAYMENT_LINK_AGENCY", "https://buy.stripe.com/agency_any");
    expect(planCheckoutHref("agency", "month")).toBe("https://buy.stripe.com/agency_any");
    expect(planCheckoutHref("agency", "year")).toBe("https://buy.stripe.com/agency_any");
  });

  it("ignores a malformed configured value and falls back to /signup (never routes money off-Stripe)", () => {
    vi.stubEnv("VITE_STRIPE_PAYMENT_LINK_STARTER_MONTH", "https://evil.example.com/pay");
    expect(planCheckoutHref("starter", "month")).toBe("/signup?plan=starter&billing=month");
  });
});
