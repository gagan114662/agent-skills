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

const PRO_PLAN: PlanDto = {
  key: "pro",
  name: "Pro",
  tagline: "The whole department, on tap.",
  priceCents: 19_900,
  currency: "usd",
  interval: "month",
  agentSeats: 10,
  monthlySessionBudgetCents: 100_000,
  fleetSize: 3,
  productLimits: {
    activeCampaignLanes: 3,
    connectedChannels: 3,
    dailyOutreachSends: 150,
    approvalQueueSize: 75,
    dashboardHistoryDays: 90,
  },
  dailyValue: "SEO, content, outreach, and analytics agents working together.",
  dailyLimit: "3 active campaign lanes, 10 agents, $1,000/mo work cap.",
  upgradeTrigger: "Upgrade when you need more brands, clients, or parallel departments.",
  highlights: ["10 agent seats"],
  featured: true,
};

const PLANS: PlanDto[] = [
  PRO_PLAN,
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
    expect(screen.getByText(/10\s+seats/)).toBeInTheDocument();
    // estimatedCostCents 137 → $1.37, cap 500 → $5.00.
    expect(screen.getByText("$1.37")).toBeInTheDocument();
    expect(screen.getByText(/\/\s+\$5\.00\s+cap/)).toBeInTheDocument();
    expect(screen.getByRole("meter", { name: BILLING.panel.usageLabel })).toHaveAttribute("aria-valuenow", "137");
    expect(screen.getByText(BILLING.panel.valueReadyTitle)).toBeInTheDocument();
    expect(screen.getByText(/\$3\.63 of \$5\.00 remains/i)).toBeInTheDocument();
  });

  it("surfaces the plan's everyday value, hard limit, and upgrade trigger (#1290)", () => {
    render(<BillingSettings current={ACTIVE} plans={PLANS} usage={USAGE} />);
    expect(screen.getByText(BILLING.panel.dailyValueLabel)).toBeInTheDocument();
    expect(screen.getByText(PRO_PLAN.dailyValue)).toBeInTheDocument();
    expect(screen.getByText(BILLING.panel.dailyLimitLabel)).toBeInTheDocument();
    expect(screen.getByText(PRO_PLAN.dailyLimit)).toBeInTheDocument();
    expect(screen.getByText(BILLING.panel.productLimitsLabel)).toBeInTheDocument();
    expect(screen.getByText(BILLING.panel.connectedChannelsLabel)).toBeInTheDocument();
    expect(screen.getByText("3 channels")).toBeInTheDocument();
    expect(screen.getByText(BILLING.panel.dailyOutreachSendsLabel)).toBeInTheDocument();
    expect(screen.getByText("150 sends/day")).toBeInTheDocument();
    expect(screen.getByText(BILLING.panel.upgradeTriggerLabel)).toBeInTheDocument();
    expect(screen.getByText(PRO_PLAN.upgradeTrigger)).toBeInTheDocument();
  });

  it("shows a cap-hit upgrade moment when the workspace is out of monthly room (#1290)", () => {
    render(
      <BillingSettings
        current={ACTIVE}
        plans={PLANS}
        usage={{ ...USAGE, estimatedCostCents: 500, overBudget: true }}
      />,
    );
    expect(screen.getByText(BILLING.panel.valuePausedTitle)).toBeInTheDocument();
    expect(screen.getByText(/used its \$5\.00 agent-work cap/i)).toBeInTheDocument();
    expect(screen.getByRole("meter", { name: BILLING.panel.usageLabel })).toHaveAttribute("aria-valuenow", "500");
  });

  it("falls back to the trial label when no plan is active", () => {
    render(<BillingSettings current={null} plans={PLANS} usage={null} />);
    expect(screen.getByText(BILLING.panel.trialPlan)).toBeInTheDocument();
    // No usage yet → spend shows $0.00.
    expect(screen.getByText("$0.00")).toBeInTheDocument();
  });

  it("shows the clearly-marked test-mode note by default (no live charges)", () => {
    render(<BillingSettings current={ACTIVE} plans={PLANS} usage={USAGE} />);
    expect(screen.getByText(BILLING.panel.testModeTitle)).toBeInTheDocument();
    expect(screen.getByText(BILLING.panel.testModeBody)).toBeInTheDocument();
    // The live note is NOT shown in test mode.
    expect(screen.queryByText(BILLING.panel.liveModeTitle)).not.toBeInTheDocument();
  });

  it("shows the live-mode note once go-live is on (#481), not the test note", () => {
    render(<BillingSettings current={ACTIVE} plans={PLANS} usage={USAGE} live />);
    expect(screen.getByText(BILLING.panel.liveModeTitle)).toBeInTheDocument();
    expect(screen.getByText(BILLING.panel.liveModeBody)).toBeInTheDocument();
    expect(screen.queryByText(BILLING.panel.testModeTitle)).not.toBeInTheDocument();
  });

  it("shows invoice and receipt links when paid invoices exist (#860)", () => {
    render(
      <BillingSettings
        current={ACTIVE}
        plans={PLANS}
        usage={USAGE}
        invoices={[
          {
            id: "re_1",
            providerEventId: "evt_1",
            providerInvoiceId: "in_123",
            number: "INV-123",
            hostedInvoiceUrl: "https://billing.example/in_123",
            invoicePdfUrl: "https://billing.example/in_123.pdf",
            status: "paid",
            amountCents: 19900,
            currency: "usd",
            createdAt: "2026-06-24T00:00:00.000Z",
          },
        ]}
      />,
    );
    expect(screen.getByRole("region", { name: BILLING.panel.invoicesTitle })).toBeInTheDocument();
    expect(screen.getByText("INV-123")).toBeInTheDocument();
    expect(screen.getByText("$199.00")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: BILLING.panel.invoicePdfLabel })).toHaveAttribute(
      "href",
      "https://billing.example/in_123.pdf",
    );
  });
});
