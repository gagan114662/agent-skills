/**
 * FounderPanel switch wiring (#169 bug 12). The kill-switch / maintenance toggles used to be dead text;
 * they now drive the real human-gated endpoints with an optimistic flip that reverts on failure. This
 * test mounts the container against the singleton api and exercises confirm → optimistic → reconcile and
 * confirm → optimistic → revert-on-error.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor, act, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { FounderPanel } from "./FounderPanel.js";
import { api } from "../api/client.js";
import type { FounderConsoleDto, MaintenanceState } from "../api/types.js";
import { renderWithStore } from "../test/utils.js";

const consoleDto = (over: Partial<FounderConsoleDto["switches"]> = {}): FounderConsoleDto => ({
  workspaceId: "w1",
  generatedAtMs: 1_700_000_000_000,
  fleet: { activeSessions: 0, sessionsThisWindow: 0, globalInFlight: 0 },
  venturePipeline: { total: 0, active: 0, funded: 0, killed: 0, escalated: 0 },
  revenue: {
    currency: "usd",
    totalCents: 0,
    paymentCount: 0,
    willingnessToPayCount: 0,
    hasWillingnessToPay: false,
  },
  budget: {
    window: "2026-06",
    estimatedCostCents: 0,
    budgetCents: 0,
    overBudget: false,
    utilization: null,
  },
  pendingApprovals: [],
  switches: { killSwitch: false, maintenance: { enabled: false }, ...over },
  attention: { required: false, reasons: [] },
});

afterEach(() => vi.restoreAllMocks());

async function mountLoaded(over?: Partial<FounderConsoleDto["switches"]>) {
  vi.spyOn(api, "getFounderConsole").mockResolvedValue(consoleDto(over));
  const utils = renderWithStore(<FounderPanel />);
  await act(async () => {
    await utils.store.bootstrap();
  });
  // Wait for the console roll-up to render.
  await screen.findByText("Kill switch");
  return utils;
}

describe("FounderPanel switch wiring (#169 bug 12)", () => {
  it("optimistically engages the kill switch, then reconciles with the server", async () => {
    await mountLoaded();
    let resolve!: (v: { ok: boolean; killSwitch: boolean }) => void;
    const pending = new Promise<{ ok: boolean; killSwitch: boolean }>((r) => (resolve = r));
    const spy = vi.spyOn(api, "setKillSwitch").mockReturnValue(pending);

    await userEvent.click(screen.getByRole("button", { name: /engage/i }));
    await userEvent.click(screen.getByRole("button", { name: /^confirm$/i }));

    // Optimistic: the UI shows "engaged" before the request resolves, and it called the gated endpoint.
    expect(spy).toHaveBeenCalledWith("w1", true);
    expect(screen.getByText(/🔴 engaged/)).toBeInTheDocument();

    await act(async () => {
      resolve({ ok: true, killSwitch: true });
      await pending;
    });
    // Reconciled to the server's truth (still engaged), no error.
    expect(screen.getByText(/🔴 engaged/)).toBeInTheDocument();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("reverts the kill switch and shows an error when the request fails", async () => {
    await mountLoaded();
    vi.spyOn(api, "setKillSwitch").mockRejectedValue(new Error("403"));

    await userEvent.click(screen.getByRole("button", { name: /engage/i }));
    await userEvent.click(screen.getByRole("button", { name: /^confirm$/i }));

    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent(/couldn't update the kill switch/i),
    );
    // Reverted to off (scope to the kill-switch row — maintenance is also "off").
    const killRow = screen.getByText("Kill switch").closest(".founder__switch") as HTMLElement;
    expect(within(killRow).getByText(/🟢 off/)).toBeInTheDocument();
  });

  it("flips maintenance through the real endpoint and reconciles to the returned state", async () => {
    await mountLoaded();
    const next: MaintenanceState = { enabled: true, since: "2026-06-12T00:00:00.000Z", by: "me1" };
    const spy = vi.spyOn(api, "setMaintenance").mockResolvedValue(next);

    await userEvent.click(screen.getByRole("button", { name: /^enable$/i }));
    await userEvent.click(screen.getByRole("button", { name: /^confirm$/i }));

    expect(spy).toHaveBeenCalledWith(true);
    await waitFor(() => expect(screen.getByText(/🔴 active/)).toBeInTheDocument());
  });
});
