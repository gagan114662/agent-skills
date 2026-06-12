import { describe, expect, it } from "vitest";
import { render, screen, within } from "@testing-library/react";
import { BriefingsPanel } from "./BriefingsPanel.js";
import type { DailyBriefDto, DecisionQueueDto, WeeklyReportDto } from "../api/types.js";

const daily = (over: Partial<DailyBriefDto> = {}): DailyBriefDto => ({
  workspaceId: "ws-1",
  generatedAtMs: 1_700_000_000_000,
  shipped: [{ title: "Ship A", ref: "pr-1" }],
  blocked: [],
  decisionsWaiting: [],
  spend: { estimatedCostCents: 4200, budgetCents: 10000, currency: "usd", overBudget: false, utilization: 0.42 },
  constitution: { open: 0, topCodes: [] },
  text: "ipop daily brief — 2026-06-12. Shipped 1 item: Ship A.",
  wordCount: 9,
  ...over,
});

const queue = (over: Partial<DecisionQueueDto> = {}): DecisionQueueDto => ({
  workspaceId: "ws-1",
  generatedAtMs: 1_700_000_000_000,
  items: [],
  total: 0,
  byImpact: { critical: 0, high: 0, normal: 0 },
  stale: 0,
  critical: 0,
  ...over,
});

const weekly = (over: Partial<WeeklyReportDto> = {}): WeeklyReportDto => ({
  workspaceId: "ws-1",
  generatedAtMs: 1_700_000_000_000,
  currency: "usd",
  revenueTotalCents: 50000,
  ventures: [],
  recommendations: { doubleDown: 0, maintain: 0, pivot: 0, sunset: 0 },
  voiceSignals: [],
  backlog: [],
  text: "ipop weekly founder report — 2026-06-12. Revenue $500.00 across 0 ventures.",
  wordCount: 12,
  ...over,
});

describe("BriefingsPanel", () => {
  it("renders the daily brief text + spend", () => {
    render(<BriefingsPanel daily={daily()} decisionQueue={queue()} weekly={weekly()} />);
    expect(screen.getByText(/ipop daily brief/)).toBeInTheDocument();
    expect(screen.getByText(/Spend \$42\.00 \/ \$100\.00/)).toBeInTheDocument();
  });

  it("renders the decision queue with the one-tap link, age, and escalation badge", () => {
    const q = queue({
      total: 1,
      items: [
        {
          kind: "guardrail_escalation",
          id: "r1",
          title: "Auto-merge blocked — protected path",
          impact: "high",
          ageSeconds: 200 * 3600,
          escalationLevel: 3,
          createdAtMs: 1_699_000_000_000,
          link: "https://example.com/pr/1",
        },
      ],
    });
    render(<BriefingsPanel daily={daily()} decisionQueue={q} weekly={weekly()} />);
    const region = screen.getByLabelText("Decision queue");
    expect(within(region).getByText("Decisions waiting (1)")).toBeInTheDocument();
    const link = within(region).getByRole("link", { name: /Auto-merge blocked/ });
    expect(link).toHaveAttribute("href", "https://example.com/pr/1");
    expect(within(region).getByText("8d")).toBeInTheDocument();
    expect(within(region).getByText("critical")).toBeInTheDocument();
  });

  it("renders the per-venture P&L table with net, margin, and score movement", () => {
    const w = weekly({
      ventures: [
        {
          ideaId: "alpha",
          status: "active",
          decision: "DOUBLE_DOWN",
          currentScore: 80,
          previousScore: 70,
          scoreDelta: 10,
          revenueCents: 10000,
          costCents: 4000,
          netCents: 6000,
          marginPct: 60,
          hasPnl: true,
        },
      ],
      backlog: [{ title: "Ship onboarding", score: 12, position: 1 }],
    });
    render(<BriefingsPanel daily={daily()} decisionQueue={queue()} weekly={w} />);
    const region = screen.getByLabelText("Weekly founder report");
    expect(within(region).getByText("DOUBLE_DOWN")).toBeInTheDocument();
    expect(within(region).getByText("+10")).toBeInTheDocument();
    expect(within(region).getByText("$60.00")).toBeInTheDocument(); // net
    expect(within(region).getByText("60%")).toBeInTheDocument(); // margin
    expect(within(region).getByText(/Next week: Ship onboarding/)).toBeInTheDocument();
  });

  it("shows friendly empty states when nothing is waiting", () => {
    render(<BriefingsPanel daily={daily()} decisionQueue={queue()} weekly={weekly()} />);
    expect(screen.getByText(/No approvals, escalations, or flags need you\./)).toBeInTheDocument();
  });
});
