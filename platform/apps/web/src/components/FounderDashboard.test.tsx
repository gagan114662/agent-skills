import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { FounderDashboard } from "./FounderDashboard.js";
import type { FounderConsoleDto } from "../api/types.js";

const console_ = (over: Partial<FounderConsoleDto> = {}): FounderConsoleDto => ({
  workspaceId: "ws-1",
  generatedAtMs: 1_700_000_000_000,
  fleet: { activeSessions: 2, sessionsThisWindow: 9, globalInFlight: 5 },
  venturePipeline: { total: 4, active: 1, funded: 2, killed: 1, escalated: 0 },
  revenue: { currency: "usd", totalCents: 12500, paymentCount: 3, willingnessToPayCount: 3, hasWillingnessToPay: true },
  budget: { window: "2026-06", estimatedCostCents: 4200, budgetCents: 10000, overBudget: false, utilization: 0.42 },
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
          budget: { window: "2026-06", estimatedCostCents: 10000, budgetCents: 10000, overBudget: true, utilization: 1 },
        })}
      />,
    );
    expect(screen.getByText(/over budget/i)).toBeInTheDocument();
  });

  it("renders the safety switches read-only", () => {
    render(
      <FounderDashboard
        console={console_({ switches: { killSwitch: true, maintenance: { enabled: true } } })}
      />,
    );
    expect(screen.getByText(/🔴 engaged/)).toBeInTheDocument(); // kill switch
    expect(screen.getByText(/🔴 active/)).toBeInTheDocument(); // maintenance
  });
});
