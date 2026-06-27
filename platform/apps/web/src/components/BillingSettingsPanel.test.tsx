/**
 * BillingSettingsPanel (#215 container) — fetches the active plan (#125) + this-window usage (#71), renders
 * the {@link BillingSettings} summary, and embeds the {@link PricingPanel} so a customer can upgrade right
 * from Settings (the conversion path that was missing). Mirrors the booted-store api-spy pattern of
 * PricingPanel.test.tsx.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, act } from "@testing-library/react";
import type { PlansResponseDto } from "@reload/shared";
import type { UsageReport } from "../api/types.js";
import { BillingSettingsPanel } from "./BillingSettingsPanel.js";
import { api } from "../api/client.js";
import { BILLING } from "../brand.js";
import { createStore } from "../store/store.js";
import { StoreProvider } from "../store/StoreContext.js";
import { makeFakeDeps, TEST_IDENTITY } from "../test/utils.js";

const PLANS_RESPONSE: PlansResponseDto = {
  current: {
    planKey: "pro",
    status: "active",
    agentSeats: 10,
    monthlySessionBudgetCents: 100_000,
    fleetSize: 3,
    activatedAt: "2026-06-14T00:00:00.000Z",
  },
  plans: [
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
    },
  ],
};

const USAGE: UsageReport = {
  window: "2026-06",
  sessionsStarted: 2,
  computeSeconds: 60,
  estimatedCostCents: 250,
  caps: { tenantConcurrency: 3, budgetCents: 500, warmPoolSize: 1, regions: [] },
  inFlight: { tenant: 0, global: 0, byRegion: {} },
  overBudget: false,
};

async function bootedStore(workspaceId: string) {
  const { deps } = makeFakeDeps({ me: async () => ({ ...TEST_IDENTITY, workspaceId }) });
  const store = createStore(deps);
  await act(async () => {
    await store.bootstrap();
  });
  return store;
}

afterEach(() => vi.restoreAllMocks());

describe("BillingSettingsPanel (#215)", () => {
  it("renders the current plan + usage vs cap and embeds the upgrade table", async () => {
    vi.spyOn(api.billing, "listPlans").mockResolvedValue(PLANS_RESPONSE);
    vi.spyOn(api, "getScaleUsage").mockResolvedValue(USAGE);
    vi.spyOn(api.billing, "status").mockResolvedValue({
      provider: "none",
      mode: "test",
      live: false,
      quotas: [
        {
          resource: "connected_channels",
          label: "Connected channels",
          used: 2,
          limit: 3,
          remaining: 1,
          upgradeTrigger: "Upgrade when you need more brands, clients, or parallel departments.",
        },
      ],
    });
    vi.spyOn(api.billing, "listInvoices").mockResolvedValue({ invoices: [] });
    const store = await bootedStore("ws-billing");

    await act(async () => {
      render(
        <StoreProvider store={store}>
          <BillingSettingsPanel />
        </StoreProvider>,
      );
    });

    // Summary: active plan + usage ($2.50 of $5.00 cap).
    expect(await screen.findByText("$2.50")).toBeInTheDocument();
    expect(screen.getAllByText(/\$5\.00/).length).toBeGreaterThan(0);
    // Embedded PricingPanel renders the catalog so the upgrade path is right here in Settings.
    expect(screen.getAllByText("Pro").length).toBeGreaterThan(0);
    // Not live → the test-mode safety note shows (#481).
    expect(screen.getByText(BILLING.panel.testModeTitle)).toBeInTheDocument();
    expect(screen.getByText("2 / 3")).toBeInTheDocument();
  });

  it("flips to the live-mode note when the billing status reports go-live is on (#481)", async () => {
    vi.spyOn(api.billing, "listPlans").mockResolvedValue(PLANS_RESPONSE);
    vi.spyOn(api, "getScaleUsage").mockResolvedValue(USAGE);
    vi.spyOn(api.billing, "status").mockResolvedValue({ provider: "stripe", mode: "live", live: true, quotas: [] });
    vi.spyOn(api.billing, "listInvoices").mockResolvedValue({
      invoices: [
        {
          id: "re_1",
          providerEventId: "evt_1",
          providerInvoiceId: "in_123",
          number: "INV-123",
          hostedInvoiceUrl: "https://billing.example/in_123",
          invoicePdfUrl: null,
          status: "paid",
          amountCents: 19900,
          currency: "usd",
          createdAt: "2026-06-24T00:00:00.000Z",
        },
      ],
    });
    const store = await bootedStore("ws-billing-live");

    await act(async () => {
      render(
        <StoreProvider store={store}>
          <BillingSettingsPanel />
        </StoreProvider>,
      );
    });

    expect(await screen.findByText(BILLING.panel.liveModeTitle)).toBeInTheDocument();
    expect(screen.getByText("INV-123")).toBeInTheDocument();
    expect(screen.queryByText(BILLING.panel.testModeTitle)).not.toBeInTheDocument();
  });
});
