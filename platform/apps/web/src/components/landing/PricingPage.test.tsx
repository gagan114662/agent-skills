import { describe, expect, it } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { PricingPage } from "./PricingPage.js";
import { FAQ, LANDING, PRICING, REFUND_POLICY } from "../../brand.js";

describe("PricingPage (#214)", () => {
  it("leads with the focused pricing hero", () => {
    render(<PricingPage />);
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent(PRICING.title);
    expect(screen.getByText(PRICING.sub)).toBeInTheDocument();
  });

  it("renders all three plans with price, tagline, and 'what you get' highlights", () => {
    render(<PricingPage />);
    const grid = screen.getByRole("region", { name: PRICING.plansLabel });
    for (const plan of LANDING.plans) {
      expect(within(grid).getByText(plan.name)).toBeInTheDocument();
      expect(within(grid).getByText(plan.price)).toBeInTheDocument();
      expect(within(grid).getByText(plan.tagline)).toBeInTheDocument();
      for (const h of plan.highlights) {
        expect(within(grid).getByText(h)).toBeInTheDocument();
      }
    }
  });

  it("carries one CTA per plan that hands the chosen monthly checkout into signup", () => {
    render(<PricingPage />);
    const grid = screen.getByRole("region", { name: PRICING.plansLabel });
    for (const plan of LANDING.plans) {
      const cta = within(grid).getByRole("link", { name: new RegExp(`${PRICING.planCta}.*${plan.name}`, "i") });
      expect(cta).toHaveAttribute("href", `/signup?plan=${plan.key}&billing=month`);
    }
  });

  it("lets a price-shopping visitor switch to annual checkout before signup", async () => {
    render(<PricingPage />);
    await userEvent.click(screen.getByRole("button", { name: new RegExp(PRICING.annualLabel, "i") }));
    const grid = screen.getByRole("region", { name: PRICING.plansLabel });
    expect(within(grid).getByText("$1,990")).toBeInTheDocument();
    const pro = LANDING.plans.find((plan) => plan.key === "pro")!;
    expect(
      within(grid).getByRole("link", { name: new RegExp(`${PRICING.planCta}.*${pro.name}`, "i") }),
    ).toHaveAttribute("href", "/signup?plan=pro&billing=year");
  });

  it("keeps the no-signup demo visible from pricing", () => {
    render(<PricingPage />);
    expect(screen.getAllByRole("link", { name: /watch live demo/i })[0]).toHaveAttribute("href", "/demo");
  });

  it("marks exactly one plan as most popular", () => {
    render(<PricingPage />);
    expect(screen.getAllByText(PRICING.popularBadge)).toHaveLength(1);
  });

  it("answers pricing-specific FAQ questions surfaced from the shared FAQ", () => {
    render(<PricingPage />);
    const matched = FAQ.items.filter((item) => PRICING.faqMatch.some((re) => re.test(item.q)));
    expect(matched.map((item) => item.q)).toEqual(
      expect.arrayContaining([
        "What does it cost, and what's the difference between Starter and Pro?",
        "What do priority autonomy and deploy-to-live mean?",
      ]),
    );
    for (const item of matched) {
      expect(screen.getByText(item.q)).toBeInTheDocument();
    }
    expect(screen.getByText(/starter is \$49\/month for proving the loop/i)).toBeInTheDocument();
    expect(screen.getByText(/priority autonomy means pro work gets/i)).toBeInTheDocument();
    expect(screen.getByText(/deploy-to-live means approved site or venture changes/i)).toBeInTheDocument();
  });

  it("offers a way back to the homepage", () => {
    render(<PricingPage />);
    expect(screen.getByRole("link", { name: PRICING.backLabel })).toHaveAttribute("href", "/");
  });

  it("links the public refund policy from the pricing terms", () => {
    render(<PricingPage />);
    expect(screen.getByText(PRICING.footnote, { exact: false })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: REFUND_POLICY.navLabel })).toHaveAttribute(
      "href",
      "/refund-policy",
    );
  });
});
