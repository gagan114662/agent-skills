/**
 * PricingPanel (#125 container) loading + cache behaviour (#169 bug 11). The panel used to render an
 * empty PricingTable for the ~3s the plan request takes — a blank flash that then "popped". Now it shows
 * the three-dot pop loader on the first open and caches the catalog so a re-open is instant.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, act } from "@testing-library/react";
import type { PlansResponseDto } from "@reload/shared";
import { PricingPanel } from "./PricingPanel.js";
import { api } from "../api/client.js";
import { createStore } from "../store/store.js";
import { StoreProvider } from "../store/StoreContext.js";
import { makeFakeDeps, TEST_IDENTITY } from "../test/utils.js";

const RESPONSE: PlansResponseDto = {
  current: null,
  plans: [
    {
      key: "starter",
      name: "Starter",
      tagline: "Hire your first three agents.",
      priceCents: 4900,
      currency: "usd",
      interval: "month",
      agentSeats: 3,
      monthlySessionBudgetCents: 20_000,
      fleetSize: 1,
      highlights: ["3 agent seats"],
      featured: false,
    },
  ],
};

/** Build a store whose identity is already resolved to `workspaceId` (mirrors AuthGate gating the app). */
async function bootedStore(workspaceId: string) {
  const { deps } = makeFakeDeps({ me: async () => ({ ...TEST_IDENTITY, workspaceId }) });
  const store = createStore(deps);
  await act(async () => {
    await store.bootstrap();
  });
  return store;
}

afterEach(() => vi.restoreAllMocks());

describe("PricingPanel loading + cache (#169 bug 11)", () => {
  it("shows the pop loader while the catalog is loading, then the plans — never a blank table", async () => {
    let resolve!: (r: PlansResponseDto) => void;
    const pending = new Promise<PlansResponseDto>((r) => (resolve = r));
    vi.spyOn(api.billing, "listPlans").mockReturnValue(pending);

    const store = await bootedStore("ws-loading");
    render(
      <StoreProvider store={store}>
        <PricingPanel />
      </StoreProvider>,
    );

    // The loader is up and no plan card has rendered yet (the old blank-flash bug).
    expect(screen.getByText(/loading plans/i)).toBeInTheDocument();
    expect(screen.queryByText("Starter")).toBeNull();

    await act(async () => {
      resolve(RESPONSE);
      await pending;
    });

    expect(await screen.findByText("Starter")).toBeInTheDocument();
    expect(screen.queryByText(/loading plans/i)).toBeNull();
  });

  it("serves the cached catalog instantly on re-open — no loader, no blank", async () => {
    const spy = vi.spyOn(api.billing, "listPlans").mockResolvedValue(RESPONSE);
    const store = await bootedStore("ws-cache");

    // First open populates the module cache.
    const first = render(
      <StoreProvider store={store}>
        <PricingPanel />
      </StoreProvider>,
    );
    expect(await screen.findByText("Starter")).toBeInTheDocument();
    const callsAfterFirst = spy.mock.calls.length;
    first.unmount();

    // Second open (tab switch) renders the plans synchronously from cache, with the loader never shown.
    render(
      <StoreProvider store={store}>
        <PricingPanel />
      </StoreProvider>,
    );
    expect(screen.getByText("Starter")).toBeInTheDocument();
    expect(screen.queryByText(/loading plans/i)).toBeNull();
    // It still refreshes in the background (keeps the active-plan badge current).
    expect(spy.mock.calls.length).toBeGreaterThan(callsAfterFirst);
  });
});
