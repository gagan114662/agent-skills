import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent, within } from "@testing-library/react";
import type { ActivePlanDto, PlanDto } from "@reload/shared";
import { PricingTable, formatPrice } from "./PricingTable.js";

const plan = (over: Partial<PlanDto> = {}): PlanDto => ({
  key: "starter",
  name: "Starter",
  tagline: "Hire your first three agents.",
  priceCents: 4900,
  currency: "usd",
  interval: "month",
  agentSeats: 3,
  monthlySessionBudgetCents: 20_000,
  fleetSize: 1,
  dailyValue: "A daily marketing checkup.",
  dailyLimit: "1 active campaign, 3 agents, and a $200 monthly agent-work cap.",
  upgradeTrigger: "Upgrade when you want more lanes.",
  highlights: ["Daily SEO/content/social check-ins", "3 agent seats", "$200/mo cap with receipts"],
  featured: false,
  ...over,
});

const PLANS: PlanDto[] = [
  plan(),
  plan({ key: "pro", name: "Pro", priceCents: 19_900, featured: true }),
  plan({ key: "agency", name: "Agency", priceCents: 49_900 }),
];

describe("PricingTable (#125 — pure)", () => {
  it("formatPrice renders whole-dollar prices cleanly", () => {
    expect(formatPrice(4900)).toBe("$49");
    expect(formatPrice(19_900)).toBe("$199");
    expect(formatPrice(4999)).toBe("$49.99");
  });

  it("renders all three plans with name, price, and highlights", () => {
    render(<PricingTable plans={PLANS} current={null} onChoose={() => {}} />);
    for (const name of ["Starter", "Pro", "Agency"]) {
      expect(screen.getByText(name)).toBeInTheDocument();
    }
    expect(screen.getByText("$49")).toBeInTheDocument();
    expect(screen.getByText("$199")).toBeInTheDocument();
    expect(screen.getByText("$499")).toBeInTheDocument();
    expect(screen.getAllByText("3 agent seats").length).toBeGreaterThan(0);
    expect(screen.getAllByText("A daily marketing checkup.").length).toBeGreaterThan(0);
    expect(screen.getAllByText(/Upgrade when you want more lanes/i).length).toBeGreaterThan(0);
  });

  it("renders a selectable keep-working CTA for every tier (#234: all three plans, not just Starter)", () => {
    render(<PricingTable plans={PLANS} current={null} onChoose={() => {}} />);
    // The whole revenue ladder must be reachable — one enabled "Choose" per plan, not just the floor tier.
    for (const name of ["Starter", "Pro", "Agency"]) {
      const cta = screen.getByLabelText(`Choose the ${name} plan`);
      expect(cta).toBeEnabled();
      expect(cta).toHaveTextContent("Keep them working");
    }
    expect(screen.getAllByRole("button", { name: /Choose the .* plan/ })).toHaveLength(3);
  });

  it("flags exactly the featured plan as most popular", () => {
    render(<PricingTable plans={PLANS} current={null} onChoose={() => {}} />);
    const ribbons = screen.getAllByText("Most popular");
    expect(ribbons).toHaveLength(1);
  });

  it("shows the value-cap footnote (ipop voice)", () => {
    render(<PricingTable plans={PLANS} current={null} onChoose={() => {}} />);
    expect(
      screen.getByText("everyday work is capped before spend gets silly. the agents are enthusiastic; billing is not."),
    ).toBeInTheDocument();
  });

  it("calls onChoose with the plan key when a card's button is clicked", () => {
    const onChoose = vi.fn();
    render(<PricingTable plans={PLANS} current={null} onChoose={onChoose} />);
    fireEvent.click(screen.getByLabelText("Choose the Pro plan"));
    expect(onChoose).toHaveBeenCalledWith("pro");
  });

  it("marks the active plan and disables its button (you can't re-buy your own plan)", () => {
    const current: ActivePlanDto = {
      planKey: "pro",
      status: "active",
      agentSeats: 10,
      monthlySessionBudgetCents: 100_000,
      fleetSize: 3,
      activatedAt: "2026-06-10T00:00:00.000Z",
    };
    render(<PricingTable plans={PLANS} current={current} onChoose={() => {}} />);
    const proCta = screen.getByLabelText("Choose the Pro plan");
    expect(proCta).toBeDisabled();
    expect(within(proCta).queryByText("Your plan") ?? proCta).toHaveTextContent("Your plan");
  });

  it("shows a working state on the pending plan and surfaces an error", () => {
    render(
      <PricingTable
        plans={PLANS}
        current={null}
        onChoose={() => {}}
        pendingKey="agency"
        error="Checkout isn't switched on yet."
      />,
    );
    expect(screen.getByLabelText("Choose the Agency plan")).toHaveTextContent("Opening checkout…");
    expect(screen.getByRole("alert")).toHaveTextContent("Checkout isn't switched on yet.");
  });
});
