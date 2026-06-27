/**
 * ReportsView — the #253 proof scorecard. These tests pin the honesty contract: a connected department
 * renders its real value + trend; a "not connected" department renders the not-connected copy (its reason),
 * never a fabricated number; and the section is absent entirely when the payload predates the scorecard.
 */
import { describe, expect, it } from "vitest";
import { render, screen, within } from "@testing-library/react";
import { ReportsView } from "./ReportsView.js";
import { CONSOLE } from "../../brand.js";
import type { FounderConsoleDto } from "../../api/types.js";

function dto(over: Partial<FounderConsoleDto> = {}): FounderConsoleDto {
  return {
    workspaceId: "ws-1",
    generatedAtMs: 0,
    fleet: { activeSessions: 0, sessionsThisWindow: 0, globalInFlight: 0 },
    venturePipeline: { total: 0, active: 0, funded: 0, killed: 0, escalated: 0 },
    revenue: { currency: "usd", totalCents: 0, paymentCount: 0, willingnessToPayCount: 0, hasWillingnessToPay: false },
    budget: { window: "2026-06", estimatedCostCents: 0, budgetCents: 0, overBudget: false, utilization: null },
    pendingApprovals: [],
    switches: { killSwitch: false, maintenance: { enabled: false } },
    attention: { required: false, reasons: [] },
    ...over,
  } as FounderConsoleDto;
}

const noop = (): void => {};

describe("#253 ReportsView proof scorecard", () => {
  it("renders a connected department's real value, trend and source", () => {
    const data = dto({
      proofScorecard: {
        connectedCount: 1,
        total: 7,
        tiles: [
          {
            department: "content",
            agent: "Quill",
            title: "Content",
            metricLabel: "Articles live on the blog",
            connection: "connected",
            unit: "count",
            value: 7,
            display: "7",
            trend: "up",
            delta: 3,
            improving: true,
            trendDetail: "+3",
            source: "Published artifacts (#231)",
            note: null,
            evidenceKind: "dogfood",
            receipt: null,
          },
        ],
      },
    });
    render(<ReportsView console={data} onApprove={noop} onPeekBrief={noop} decidingId={null} />);

    expect(screen.getByText(CONSOLE.reports.proofTitle)).toBeInTheDocument();
    expect(screen.getByText("1/7 connected")).toBeInTheDocument();
    expect(screen.getByText("Quill · Content")).toBeInTheDocument();
    expect(screen.getByText("7")).toBeInTheDocument();
    expect(screen.getByText(/\+3/)).toBeInTheDocument();
    expect(screen.getByText(/dogfood/i)).toBeInTheDocument();
    expect(screen.getByText(/Published artifacts/)).toBeInTheDocument();
  });

  it("renders a not-connected department as 'not connected' with its reason — never a fake number", () => {
    const data = dto({
      proofScorecard: {
        connectedCount: 0,
        total: 7,
        tiles: [
          {
            department: "seo",
            agent: "Scout",
            title: "SEO",
            metricLabel: "Indexed pages + target-keyword positions",
            connection: "not_connected",
            unit: "count",
            value: null,
            display: "not connected",
            trend: "none",
            delta: null,
            improving: null,
            trendDetail: "—",
            source: "Search Console not connected",
            note: "connect Google Search Console to prove indexed pages + rankings",
            evidenceKind: "live",
            receipt: null,
          },
        ],
      },
    });
    render(<ReportsView console={data} onApprove={noop} onPeekBrief={noop} decidingId={null} />);

    expect(screen.getByText("not connected")).toBeInTheDocument();
    expect(screen.getByText(/Search Console not connected/)).toBeInTheDocument();
    expect(screen.getByText(/^live$/i)).toBeInTheDocument();
  });

  it("labels sample proof as sample instead of live", () => {
    const data = dto({
      proofScorecard: {
        connectedCount: 1,
        total: 7,
        tiles: [
          {
            department: "content",
            agent: "Quill",
            title: "Content",
            metricLabel: "Articles live on the blog",
            connection: "connected",
            unit: "count",
            value: 2,
            display: "2",
            trend: "none",
            delta: null,
            improving: null,
            trendDetail: "—",
            source: "Sample workspace rows",
            note: null,
            evidenceKind: "sample",
            receipt: null,
          },
        ],
      },
    });
    render(<ReportsView console={data} onApprove={noop} onPeekBrief={noop} decidingId={null} />);

    expect(screen.getByText(/^sample$/i)).toBeInTheDocument();
    expect(screen.queryByText(/^live$/i)).not.toBeInTheDocument();
  });

  it("renders per-artifact attributed revenue from the attribution ledger (#868)", () => {
    const data = dto({
      attribution: {
        totalAttributedCents: 16400,
        attributedPaymentCount: 4,
        unattributedPaymentCount: 2,
        topArtifacts: [
          {
            artifactId: "https://example.com/pricing",
            artifactKind: "seo_page",
            channel: "seo",
            attributedCents: 12200,
            currency: "usd",
            paymentCount: 3,
          },
        ],
      },
    });

    render(<ReportsView console={data} onApprove={noop} onPeekBrief={noop} decidingId={null} />);

    expect(screen.getByText("Attributed revenue")).toBeInTheDocument();
    expect(screen.getByText("4 payments")).toBeInTheDocument();
    expect(screen.getByText("$164.00")).toBeInTheDocument();
    expect(screen.getByText("$122.00")).toBeInTheDocument();
    expect(screen.getByText(/Seo Page · Seo/)).toBeInTheDocument();
    expect(screen.getByText(/https:\/\/example.com\/pricing/)).toBeInTheDocument();
  });

  it("renders an honest attribution empty state without inventing ROI (#868)", () => {
    const data = dto({
      attribution: {
        totalAttributedCents: 0,
        attributedPaymentCount: 0,
        unattributedPaymentCount: 1,
        topArtifacts: [],
      },
    });

    render(<ReportsView console={data} onApprove={noop} onPeekBrief={noop} decidingId={null} />);

    expect(screen.getByText("No attributed payments yet")).toBeInTheDocument();
    expect(within(screen.getByText("Attributed").parentElement!).getByText("$0.00")).toBeInTheDocument();
  });

  it("omits the scorecard section entirely for payloads that predate it", () => {
    render(<ReportsView console={dto()} onApprove={noop} onPeekBrief={noop} decidingId={null} />);
    expect(screen.queryByText(CONSOLE.reports.proofTitle)).not.toBeInTheDocument();
  });
});
