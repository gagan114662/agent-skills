import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { UsageDashboard } from "./UsageDashboard.js";
import type { UsageReport } from "../api/types.js";

const report = (over: Partial<UsageReport> = {}): UsageReport => ({
  window: "2026-06",
  sessionsStarted: 12,
  computeSeconds: 360,
  estimatedCostCents: 4200,
  caps: { tenantConcurrency: 5, budgetCents: 5000, warmPoolSize: 2, regions: ["iad1", "sfo1"] },
  inFlight: { tenant: 2, global: 7, byRegion: { iad1: 1, sfo1: 1 } },
  overBudget: false,
  ...over,
});

describe("UsageDashboard (#71)", () => {
  it("renders the window, sessions, compute, and cost vs budget", () => {
    render(<UsageDashboard usage={report()} />);
    expect(screen.getByText("2026-06")).toBeInTheDocument();
    expect(screen.getByText("12")).toBeInTheDocument(); // sessions started
    expect(screen.getByText(/360/)).toBeInTheDocument(); // compute-seconds
    expect(screen.getByText("$42.00")).toBeInTheDocument(); // estimated cost
    expect(screen.getByText("$50.00")).toBeInTheDocument(); // budget cap
  });

  it("shows the over-budget banner only when over budget", () => {
    const { rerender } = render(<UsageDashboard usage={report({ overBudget: false })} />);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();

    rerender(<UsageDashboard usage={report({ overBudget: true })} />);
    expect(screen.getByRole("alert")).toHaveTextContent(/over budget/i);
  });

  it("lists in-flight concurrency per region", () => {
    render(<UsageDashboard usage={report()} />);
    expect(screen.getByText(/iad1/)).toBeInTheDocument();
    expect(screen.getByText(/sfo1/)).toBeInTheDocument();
    // tenant / global in-flight surfaced
    expect(screen.getByText(/2\s*\/\s*5/)).toBeInTheDocument(); // tenant 2 of cap 5
  });

  it("renders a loading state when usage is not yet available", () => {
    render(<UsageDashboard usage={null} />);
    expect(screen.getByText(/loading/i)).toBeInTheDocument();
  });
});
