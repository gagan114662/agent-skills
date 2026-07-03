/**
 * Money-path guard for `/pricing` (#1550, evolving the #1489/#1582 pricing-CTA guard pattern).
 *
 * #1550: on the deployed page every plan card CTA dead-ended at `/signup` (no payment step) and `?plan=pro`
 * was a no-op. These tests pin the fixed contract at the source so the funnel can't silently regress again:
 *   1. with the Stripe Payment Links configured, each card CTA points at its own `buy.stripe.com` checkout,
 *      per billing interval (monthly + annual);
 *   2. the CTA is a browser-native `<a>` whose click is NOT swallowed (the #1489 root cause) and whose
 *      resting card carries no transform (the #1582 hit-box root cause) — the click actually navigates;
 *   3. `?plan=pro` visibly preselects the Pro card (deep link no longer a no-op);
 *   4. with no link configured the CTA falls back to the pre-#1550 `/signup?plan=…` hand-off — never a dead `#`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { PricingPage } from "./PricingPage.js";
import { LANDING, PRICING } from "../../brand.js";

const LINKS: Record<string, { month: string; year: string }> = {
  starter: {
    month: "https://buy.stripe.com/test_starter_month",
    year: "https://buy.stripe.com/test_starter_year",
  },
  pro: {
    month: "https://buy.stripe.com/test_pro_month",
    year: "https://buy.stripe.com/test_pro_year",
  },
  agency: {
    month: "https://buy.stripe.com/test_agency_month",
    year: "https://buy.stripe.com/test_agency_year",
  },
};

function stubStripeLinks(): void {
  for (const key of ["STARTER", "PRO", "AGENCY"] as const) {
    const plan = LINKS[key.toLowerCase()]!;
    vi.stubEnv(`VITE_STRIPE_PAYMENT_LINK_${key}_MONTH`, plan.month);
    vi.stubEnv(`VITE_STRIPE_PAYMENT_LINK_${key}_YEAR`, plan.year);
  }
}

function ctaFor(planName: string): HTMLElement {
  const grid = screen.getByRole("region", { name: PRICING.plansLabel });
  return within(grid).getByRole("link", {
    name: new RegExp(`${PRICING.planCta}.*${planName}`, "i"),
  });
}

describe("PricingPage checkout (#1550)", () => {
  const originalSearch = window.location.search;

  afterEach(() => {
    vi.unstubAllEnvs();
    window.history.replaceState({}, "", `/pricing${originalSearch}`);
  });

  describe("with Stripe Payment Links configured", () => {
    beforeEach(stubStripeLinks);

    it("points every plan card CTA at its own buy.stripe.com monthly checkout", () => {
      render(<PricingPage />);
      for (const plan of LANDING.plans) {
        expect(ctaFor(plan.name)).toHaveAttribute("href", LINKS[plan.key]!.month);
      }
    });

    it("switches every CTA to the annual buy.stripe.com checkout when the visitor picks Annual", async () => {
      render(<PricingPage />);
      await userEvent.click(
        screen.getByRole("button", { name: new RegExp(PRICING.annualLabel, "i") }),
      );
      for (const plan of LANDING.plans) {
        expect(ctaFor(plan.name)).toHaveAttribute("href", LINKS[plan.key]!.year);
      }
    });

    it("uses a native <a> whose click is not swallowed (navigation actually happens)", () => {
      render(<PricingPage />);
      const pro = LANDING.plans.find((p) => p.key === "pro")!;
      const cta = ctaFor(pro.name);
      expect(cta.tagName).toBe("A");
      // A real anchor navigation is not preventDefault'd — dispatchEvent returns true when default fires.
      const notSwallowed = cta.dispatchEvent(
        new MouseEvent("click", { bubbles: true, cancelable: true }),
      );
      expect(notSwallowed).toBe(true);
    });
  });

  it("preselects the Pro card when arriving via ?plan=pro (deep link is no longer a no-op)", () => {
    window.history.replaceState({}, "", "/pricing?plan=pro");
    render(<PricingPage />);
    const grid = screen.getByRole("region", { name: PRICING.plansLabel });
    const selected = within(grid).getByRole("listitem", { current: true });
    expect(within(selected).getByRole("heading", { level: 2 })).toHaveTextContent("Pro");
  });

  it("falls back to the /signup hand-off when no Payment Link is configured (never a dead link)", () => {
    render(<PricingPage />);
    for (const plan of LANDING.plans) {
      expect(ctaFor(plan.name)).toHaveAttribute("href", `/signup?plan=${plan.key}&billing=month`);
    }
  });
});
