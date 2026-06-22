/**
 * BudgetSettings (#670 pure summary) — renders the spend-cap position + pending raises from already-fetched
 * data, and surfaces the raise/lower/approve/reject actions through callbacks. No store/network.
 */
import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import type { BudgetStatusDto, CapRaiseDto } from "../api/types.js";
import { BudgetSettings } from "./BudgetSettings.js";

const STATUS: BudgetStatusDto = {
  capCents: 10_000,
  committedCents: 6_000,
  projectedCents: 2_000,
  totalCents: 8_000,
  availableCents: 2_000,
  utilizationBps: 8_000,
  halted: false,
  alerting: true,
};

const PENDING: CapRaiseDto[] = [
  {
    id: "raise-1",
    workspaceId: "ws-1",
    fromCents: 10_000,
    toCents: 25_000,
    status: "pending",
    requestedByMemberId: "alice",
    requestedAt: "2026-06-21T00:00:00.000Z",
    decidedByMemberId: null,
    decidedAt: null,
    reason: null,
  },
];

const noop = () => {};

function renderSettings(overrides: Partial<React.ComponentProps<typeof BudgetSettings>> = {}) {
  return render(
    <BudgetSettings
      enabled
      status={STATUS}
      pendingRaises={PENDING}
      onRequestRaise={noop}
      onLower={noop}
      onApprove={noop}
      onReject={noop}
      {...overrides}
    />,
  );
}

describe("BudgetSettings (#670)", () => {
  it("renders the cap figures in dollars", () => {
    renderSettings();
    expect(screen.getByText("$100.00")).toBeTruthy(); // cap
    expect(screen.getByText("$60.00")).toBeTruthy(); // committed
    expect(screen.getAllByText("$20.00").length).toBe(2); // projected + available
    expect(screen.getByText(/80\.0% of cap used/)).toBeTruthy();
  });

  it("shows the approaching-cap badge when alerting but not halted", () => {
    renderSettings();
    expect(screen.getByText(/Approaching cap/)).toBeTruthy();
  });

  it("shows the halted badge when spend is halted", () => {
    renderSettings({ status: { ...STATUS, halted: true } });
    expect(screen.getByText(/Spend halted/)).toBeTruthy();
  });

  it("lists a pending cap-raise with its from→to amounts", () => {
    renderSettings();
    expect(screen.getByText("$100.00 → $250.00")).toBeTruthy();
    expect(screen.getByText(/requested by alice/)).toBeTruthy();
  });

  it("submits a raise request in cents", () => {
    const onRequestRaise = vi.fn();
    renderSettings({ onRequestRaise });
    fireEvent.change(screen.getByLabelText(/Request higher cap/), { target: { value: "300" } });
    fireEvent.click(screen.getByRole("button", { name: "Request raise" }));
    expect(onRequestRaise).toHaveBeenCalledWith(30_000);
  });

  it("approves a pending raise by id", () => {
    const onApprove = vi.fn();
    renderSettings({ onApprove });
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));
    expect(onApprove).toHaveBeenCalledWith("raise-1");
  });

  it("renders an off note when the governor is disabled", () => {
    renderSettings({ enabled: false, status: null });
    expect(screen.getByText(/governor is off/)).toBeTruthy();
  });
});
