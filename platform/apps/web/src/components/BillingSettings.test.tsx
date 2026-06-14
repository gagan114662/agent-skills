/**
 * BillingSettings (#215 pure summary) — renders the current plan, this-window usage vs cap, and the
 * clearly-marked test-mode note from already-fetched data. No store/network: a deterministic render test.
 */
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import type { ActivePlanDto, PlanDto } from "@reload/shared";
import type { UsageReport } from "../api/types.js";
import { BillingSettings } from "./BillingSettings.js";
import { BILLING } from "../brand.js";

const PLANS: PlanDto[] = [
  {
    key: "pro",
    name: "Pro",
    tagline: "The whole department, on tap.",
    priceCents: 19_900,
    currency: "usd",
    interval: "month",
    agentSeats: 10,
    monthlySessionBudgetCents: 100_000,
    fleetSize: 3,
    highlights: ["10 agent seats"],
    featured: true,
  },
];

const ACTIVE: ActivePlanDto = {
  planKey: "pro",
  status: "active",
  agentSeats: 10,
  monthlySessionBudgetCents: 100_000,
  fleetSize: 3,
  activatedAt: "2026-06-14T00:00:00.000Z",
};

const USAGE: UsageReport = {
  window: "2026-06",
  sessionsStarted: 4,
  computeSeconds: 120,
  estimatedCostCents: 137,
  caps: { tenantConcurrency: 3, budgetCents: 500, warmPoolSize: 1, regions: [] },
  inFlight: { tenant: 0, global: 0, byRegion: {} },
  overBudget: false,
};

describe("BillingSettings (#215)", () => {
  it("shows the active plan name, seats, and usage vs cap", () => {
    render(<BillingSettings current={ACTIVE} plans={PLANS} usage={USAGE} />);
    expect(screen.getByText("Pro")).toBeInTheDocument();
    expect(screen.getByText(/10/)).toBeInTheDocument();
    // estimatedCostCents 137 → $1.37, cap 500 → $5.00.
    expect(screen.getByText("$1.37")).toBeInTheDocument();
    expect(screen.getByText(/\$5\.00/)).toBeInTheDocument();
  });

  it("falls back to the trial label when no plan is active", () => {
    render(<BillingSettings current={null} plans={PLANS} usage={null} />);
    expect(screen.getByText(BILLING.panel.trialPlan)).toBeInTheDocument();
    // No usage yet → spend shows $0.00.
    expect(screen.getByText("$0.00")).toBeInTheDocument();
  });

  it("always shows the clearly-marked test-mode note (no live charges)", () => {
    render(<BillingSettings current={ACTIVE} plans={PLANS} usage={USAGE} />);
    expect(screen.getByText(BILLING.panel.testModeTitle)).toBeInTheDocument();
    expect(screen.getByText(BILLING.panel.testModeBody)).toBeInTheDocument();
  });
});
