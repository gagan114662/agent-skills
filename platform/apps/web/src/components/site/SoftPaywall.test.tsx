import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { SoftPaywall } from "./SoftPaywall.js";
import { api } from "../../api/client.js";
import { PAYWALL } from "../../brand.js";

afterEach(() => vi.restoreAllMocks());

const plansRes = {
  plans: [
    { key: "pro", name: "Pro", tagline: "", priceCents: 19900, currency: "usd", interval: "month", agentSeats: 10, monthlySessionBudgetCents: 100000, fleetSize: 3, productLimits: { activeCampaignLanes: 3, connectedChannels: 3, dailyOutreachSends: 150, approvalQueueSize: 75, dashboardHistoryDays: 90 }, dailyValue: "SEO, content, outreach, and analytics agents working together.", dailyLimit: "3 active campaign lanes, 10 agents, $1,000/mo work cap.", upgradeTrigger: "Upgrade when you need more brands, clients, or parallel departments.", highlights: [], featured: true },
  ],
  current: { planKey: "pro", status: "active", agentSeats: 10, monthlySessionBudgetCents: 100000, fleetSize: 3, activatedAt: "2026-06-01" },
};

describe("#153 soft paywall", () => {
  it("names the real current plan and routes the CTA to pricing", async () => {
    vi.spyOn(api.billing, "listPlans").mockResolvedValue(plansRes);
    const onSeePlans = vi.fn();
    const onDismiss = vi.fn();
    render(<SoftPaywall workspaceId="w1" onSeePlans={onSeePlans} onDismiss={onDismiss} />);

    expect(screen.getByText(PAYWALL.title)).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText(PAYWALL.onPlan("Pro"))).toBeInTheDocument());

    fireEvent.click(screen.getByRole("button", { name: PAYWALL.cta }));
    expect(onSeePlans).toHaveBeenCalledOnce();

    fireEvent.click(screen.getByRole("button", { name: PAYWALL.dismiss }));
    expect(onDismiss).toHaveBeenCalledOnce();
  });

  it("falls back to a Free plan label when there's no active plan (the trial)", async () => {
    vi.spyOn(api.billing, "listPlans").mockResolvedValue({ plans: [], current: null });
    render(<SoftPaywall workspaceId="w1" onSeePlans={vi.fn()} onDismiss={vi.fn()} />);
    await waitFor(() => expect(screen.getByText(PAYWALL.onPlan("Free"))).toBeInTheDocument());
  });
});
