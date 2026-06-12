import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { FounderDashboard } from "./FounderDashboard.js";
import type { FounderConsoleDto } from "../api/types.js";

const console_ = (over: Partial<FounderConsoleDto> = {}): FounderConsoleDto => ({
  workspaceId: "ws-1",
  generatedAtMs: 1_700_000_000_000,
  fleet: { activeSessions: 2, sessionsThisWindow: 9, globalInFlight: 5 },
  venturePipeline: { total: 4, active: 1, funded: 2, killed: 1, escalated: 0 },
  revenue: {
    currency: "usd",
    totalCents: 12500,
    paymentCount: 3,
    willingnessToPayCount: 3,
    hasWillingnessToPay: true,
  },
  budget: {
    window: "2026-06",
    estimatedCostCents: 4200,
    budgetCents: 10000,
    overBudget: false,
    utilization: 0.42,
  },
  pendingApprovals: [],
  switches: { killSwitch: false, maintenance: { enabled: false } },
  attention: { required: false, reasons: [] },
  ...over,
});

describe("FounderDashboard (#104)", () => {
  it("renders a loading state when the console is not yet available", () => {
    render(<FounderDashboard console={null} />);
    expect(screen.getByText(/loading/i)).toBeInTheDocument();
  });

  it("renders the reliability insights pane (#148): MTTR, frequency, open count, noisiest", () => {
    render(
      <FounderDashboard
        console={console_({
          reliability: {
            mttrMs: 30 * 60_000, // 30 min
            incidentsLast7d: 2,
            incidentsLast30d: 5,
            openCount: 1,
            total: 9,
            noisiestComponents: [{ service: "api", count: 4 }],
          },
        })}
      />,
    );
    const card = screen.getByRole("heading", { name: /reliability/i }).closest("article")!;
    expect(card).toHaveTextContent(/30 min/i); // MTTR formatted
    expect(card).toHaveTextContent("api"); // noisiest component
    expect(card).toHaveTextContent("1"); // open incidents
  });

  it("renders a zeroed reliability pane when the field is absent (loop off / unwired)", () => {
    render(<FounderDashboard console={console_()} />);
    const card = screen.getByRole("heading", { name: /reliability/i }).closest("article")!;
    expect(card).toHaveTextContent(/—|n\/a|no incidents/i); // no MTTR yet
  });

  it("shows an all-clear banner when nothing needs the owner", () => {
    render(<FounderDashboard console={console_()} />);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByText(/all clear/i)).toBeInTheDocument();
  });

  it("shows the attention banner with every reason when the platform needs a human", () => {
    render(
      <FounderDashboard
        console={console_({
          attention: { required: true, reasons: ["kill switch engaged", "2 pending approvals"] },
        })}
      />,
    );
    const banner = screen.getByRole("alert");
    expect(banner).toHaveTextContent(/needs you/i);
    expect(banner).toHaveTextContent("kill switch engaged");
    expect(banner).toHaveTextContent("2 pending approvals");
  });

  it("lists pending approvals with their time-in-queue age (the decision SLA)", () => {
    render(
      <FounderDashboard
        console={console_({
          attention: { required: true, reasons: ["1 pending approval"] },
          pendingApprovals: [
            {
              id: "p1",
              actionType: "money.payout",
              summary: "refund $5.00",
              amount: 500,
              ageSeconds: 3700,
              createdAtMs: 1_699_999_000_000,
            },
          ],
        })}
      />,
    );
    expect(screen.getByText("money.payout")).toBeInTheDocument();
    expect(screen.getByText("refund $5.00")).toBeInTheDocument();
    expect(screen.getByText("$5.00")).toBeInTheDocument(); // the amount
    expect(screen.getByText("1h")).toBeInTheDocument(); // 3700s → 1h
  });

  it("surfaces the venture pipeline, revenue, and willingness-to-pay signal", () => {
    render(<FounderDashboard console={console_()} />);
    expect(screen.getByText("Venture pipeline")).toBeInTheDocument();
    expect(screen.getByText("$125.00")).toBeInTheDocument(); // revenue total
    expect(screen.getByText(/3\s*✓/)).toBeInTheDocument(); // WTP count with the ✓ signal
  });

  it("shows the over-budget alert only when over budget", () => {
    const { rerender } = render(<FounderDashboard console={console_()} />);
    expect(screen.queryByText(/over budget/i)).not.toBeInTheDocument();

    rerender(
      <FounderDashboard
        console={console_({
          budget: {
            window: "2026-06",
            estimatedCostCents: 10000,
            budgetCents: 10000,
            overBudget: true,
            utilization: 1,
          },
        })}
      />,
    );
    expect(screen.getByText(/over budget/i)).toBeInTheDocument();
  });

  it("renders the safety switches read-only when no control callbacks are wired", () => {
    render(
      <FounderDashboard
        console={console_({ switches: { killSwitch: true, maintenance: { enabled: true } } })}
      />,
    );
    expect(screen.getByText(/🔴 engaged/)).toBeInTheDocument(); // kill switch
    expect(screen.getByText(/🔴 active/)).toBeInTheDocument(); // maintenance
    // No fake toggles: with no callback there is nothing to click.
    expect(screen.queryByRole("button", { name: /engage|resume/i })).toBeNull();
  });

  it("makes the kill switch interactive when a callback is wired, behind a confirm step (#169 bug 12)", async () => {
    const onToggleKillSwitch = vi.fn();
    render(
      <FounderDashboard
        console={console_({ switches: { killSwitch: false, maintenance: { enabled: false } } })}
        onToggleKillSwitch={onToggleKillSwitch}
      />,
    );

    // A click opens a confirm step; it does NOT fire the toggle yet.
    await userEvent.click(screen.getByRole("button", { name: /engage/i }));
    expect(onToggleKillSwitch).not.toHaveBeenCalled();
    expect(screen.getByText(/halts every autonomous session/i)).toBeInTheDocument();

    // Confirming fires the toggle with the next value (off → on).
    await userEvent.click(screen.getByRole("button", { name: /^confirm$/i }));
    expect(onToggleKillSwitch).toHaveBeenCalledWith(true);
  });

  it("cancelling the confirm does not fire the toggle", async () => {
    const onToggleMaintenance = vi.fn();
    render(
      <FounderDashboard
        console={console_({ switches: { killSwitch: false, maintenance: { enabled: false } } })}
        onToggleMaintenance={onToggleMaintenance}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: /enable/i }));
    await userEvent.click(screen.getByRole("button", { name: /cancel/i }));
    expect(onToggleMaintenance).not.toHaveBeenCalled();
  });

  it("shows a working state and disables the control while a toggle is in flight", () => {
    render(
      <FounderDashboard
        console={console_({ switches: { killSwitch: false, maintenance: { enabled: false } } })}
        onToggleKillSwitch={vi.fn()}
        switchBusy={{ kill: true }}
      />,
    );
    const btn = screen.getByRole("button", { name: /working/i });
    expect(btn).toBeDisabled();
  });

  it("keeps maintenance read-only (no fake toggle) when the flag store is unavailable", () => {
    render(
      <FounderDashboard
        console={console_({
          switches: { killSwitch: false, maintenance: { enabled: false, unavailable: true } },
        })}
        onToggleMaintenance={vi.fn()}
      />,
    );
    expect(screen.getByText(/managed via config/i)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /enable|disable/i })).toBeNull();
  });

  it("surfaces a switch error when a toggle fails", () => {
    render(
      <FounderDashboard
        console={console_()}
        onToggleKillSwitch={vi.fn()}
        switchError="Couldn't update the kill switch. Please try again."
      />,
    );
    expect(screen.getByRole("alert")).toHaveTextContent(/couldn't update the kill switch/i);
  });
});
