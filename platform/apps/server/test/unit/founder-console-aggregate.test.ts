import { describe, it, expect } from "vitest";
import {
  aggregateFounderConsole,
  type FounderConsoleInput,
} from "../../src/founder-console/aggregate.js";

const NOW = Date.parse("2026-06-10T00:00:00Z");

/** A quiet, nothing-pending baseline — every "attention" trigger off; override per case. */
function input(over: Partial<FounderConsoleInput> = {}): FounderConsoleInput {
  return {
    workspaceId: "ws-1",
    nowMs: NOW,
    fleet: { tenantInFlight: 0, globalInFlight: 0, sessionsThisWindow: 0 },
    ventures: [],
    revenue: { currency: "usd", totalCents: 0, paymentCount: 0, evidenceCount: 0 },
    budget: {
      window: "2026-06",
      estimatedCostCents: 0,
      budgetCents: 0,
      computeSeconds: 0,
      sessionsStarted: 0,
    },
    approvals: [],
    switches: { killSwitch: false, maintenance: { enabled: false } },
    gateBoundaries: { owned: [], history: [] },
    usageTrend: [],
    forecastWindow: "2026-07",
    infraBudgetCeilingCents: 0,
    tenantConcurrency: 0,
    ...over,
  };
}

describe("aggregateFounderConsole (the pure founder-console roll-up)", () => {
  it("echoes the workspace + clock instant and the fleet snapshot", () => {
    const out = aggregateFounderConsole(
      input({ fleet: { tenantInFlight: 3, globalInFlight: 7, sessionsThisWindow: 12 } }),
    );
    expect(out.workspaceId).toBe("ws-1");
    expect(out.generatedAtMs).toBe(NOW);
    expect(out.fleet).toEqual({ activeSessions: 3, sessionsThisWindow: 12, globalInFlight: 7 });
  });

  it("rolls up the venture pipeline by status + terminal verdict", () => {
    const out = aggregateFounderConsole(
      input({
        ventures: [
          { ideaId: "a", status: "active", terminalVerdict: null, lastScore: 55 },
          { ideaId: "b", status: "terminal", terminalVerdict: "FUND", lastScore: 82 },
          { ideaId: "c", status: "terminal", terminalVerdict: "KILL", lastScore: 12 },
          { ideaId: "d", status: "terminal", terminalVerdict: "ESCALATE", lastScore: 64 },
          { ideaId: "e", status: "terminal", terminalVerdict: "ESCALATE", lastScore: 66 },
        ],
      }),
    );
    expect(out.venturePipeline).toEqual({
      total: 5,
      active: 1,
      funded: 1,
      killed: 1,
      escalated: 2,
      scaffolds: 0,
    });
  });

  it("surfaces the watch-only venture loop panel without adding attention (#1056)", () => {
    const out = aggregateFounderConsole(
      input({
        revenue: { currency: "usd", totalCents: 12_000, paymentCount: 2, evidenceCount: 2 },
        ventureLoop: {
          enabled: true,
          halted: false,
          scanned: 3,
          validating: 4,
          validated: 1,
          bootstrapPending: 2,
          launched: 5,
          killed: 1,
          activeVentures: 4,
        },
      }),
    );

    expect(out.ventureLoop).toEqual({
      enabled: true,
      halted: false,
      status: "running",
      start: 3,
      learn: 5,
      loop: 2,
      launched: 5,
      earningReceipts: 2,
      killed: 1,
      activeVentures: 4,
      watchOnly: true,
    });
    expect(out.attention).toEqual({ required: false, reasons: [] });
  });

  it("shows the venture loop as halted when the global kill switch is engaged (#1056)", () => {
    const out = aggregateFounderConsole(
      input({
        switches: { killSwitch: true, maintenance: { enabled: false } },
        ventureLoop: {
          enabled: true,
          halted: false,
          scanned: 1,
          validating: 0,
          validated: 0,
          bootstrapPending: 0,
          launched: 0,
          killed: 0,
          activeVentures: 0,
        },
      }),
    );

    expect(out.ventureLoop.status).toBe("halted");
    expect(out.ventureLoop.halted).toBe(true);
    expect(out.attention.reasons).toContain("kill switch engaged");
  });

  it("counts a terminal-FUND venture WITHOUT a passing scorecard as a zero-budget scaffold, not funded (#228)", () => {
    const out = aggregateFounderConsole(
      input({
        ventures: [
          // Cleared the #96 bar — real funded venture.
          { ideaId: "cleared", status: "terminal", terminalVerdict: "FUND", lastScore: 82, hasPassingScorecard: true },
          // Owner-activated (#230) into a build epic but never earned a passing scorecard — a scaffold.
          { ideaId: "stub", status: "terminal", terminalVerdict: "FUND", lastScore: 20, hasPassingScorecard: false },
        ],
      }),
    );
    expect(out.venturePipeline).toEqual({
      total: 2,
      active: 0,
      funded: 1, // only the cleared venture
      killed: 0,
      escalated: 0,
      scaffolds: 1, // the owner-activated stub
    });
  });

  it("treats an unknown passing-scorecard flag as funded (backward compatible — older callers)", () => {
    const out = aggregateFounderConsole(
      input({
        ventures: [
          { ideaId: "b", status: "terminal", terminalVerdict: "FUND", lastScore: 82 }, // no hasPassingScorecard
        ],
      }),
    );
    expect(out.venturePipeline.funded).toBe(1);
    expect(out.venturePipeline.scaffolds).toBe(0);
  });

  it("surfaces willingness-to-pay evidence as the fundability signal", () => {
    const none = aggregateFounderConsole(input());
    expect(none.revenue.willingnessToPayCount).toBe(0);
    expect(none.revenue.hasWillingnessToPay).toBe(false);

    const paid = aggregateFounderConsole(
      input({ revenue: { currency: "usd", totalCents: 4200, paymentCount: 2, evidenceCount: 2 } }),
    );
    expect(paid.revenue.totalCents).toBe(4200);
    expect(paid.revenue.paymentCount).toBe(2);
    expect(paid.revenue.willingnessToPayCount).toBe(2);
    expect(paid.revenue.hasWillingnessToPay).toBe(true);
  });

  it("computes budget utilization + over-budget against the cap", () => {
    const under = aggregateFounderConsole(
      input({
        budget: {
          window: "2026-06",
          estimatedCostCents: 5000,
          budgetCents: 10000,
          computeSeconds: 30,
          sessionsStarted: 4,
        },
      }),
    );
    expect(under.budget.utilization).toBe(0.5);
    expect(under.budget.overBudget).toBe(false);

    const over = aggregateFounderConsole(
      input({
        budget: {
          window: "2026-06",
          estimatedCostCents: 10000,
          budgetCents: 10000,
          computeSeconds: 60,
          sessionsStarted: 9,
        },
      }),
    );
    expect(over.budget.overBudget).toBe(true); // >= cap
    expect(over.budget.utilization).toBe(1);
  });

  it("reports null utilization when no positive budget cap is set", () => {
    const out = aggregateFounderConsole(
      input({
        budget: {
          window: "2026-06",
          estimatedCostCents: 999,
          budgetCents: 0,
          computeSeconds: 5,
          sessionsStarted: 1,
        },
      }),
    );
    expect(out.budget.utilization).toBeNull();
    expect(out.budget.overBudget).toBe(false); // a 0 cap never bites
  });

  it("turns the fleet-health signal red with a reason on an escalated ops incident or stuck agent (#193 AC3)", () => {
    const quiet = aggregateFounderConsole(input());
    expect(quiet.attention.required).toBe(false);
    expect(quiet.selfHealingOps).toEqual({ openIncidents: 0, escalatedIncidents: 0, stuckAgents: 0 });

    const red = aggregateFounderConsole(
      input({ selfHealingOps: { openIncidents: 1, escalatedIncidents: 2, stuckAgents: 1 } }),
    );
    expect(red.attention.required).toBe(true);
    expect(red.attention.reasons).toContain("2 self-healing incidents escalated (auto-remediation could not close)");
    expect(red.attention.reasons).toContain("1 stuck agent escalated by the watchdog");
    expect(red.selfHealingOps.openIncidents).toBe(1);
  });

  it("a firing/remediating ops incident alone does NOT page the owner (auto-remediation in flight)", () => {
    const out = aggregateFounderConsole(
      input({ selfHealingOps: { openIncidents: 3, escalatedIncidents: 0, stuckAgents: 0 } }),
    );
    expect(out.attention.required).toBe(false);
  });

  it("ages each pending approval and returns the queue oldest-first (the decision SLA)", () => {
    const out = aggregateFounderConsole(
      input({
        approvals: [
          { id: "new", actionType: "external.send", summary: "post tweet", amount: null, createdAtMs: NOW - 30_000 },
          { id: "old", actionType: "money.payout", summary: "refund $5", amount: 500, createdAtMs: NOW - 3_600_000 },
          { id: "mid", actionType: "autonomy.complete", summary: "ship PR", amount: null, createdAtMs: NOW - 120_000 },
        ],
      }),
    );
    expect(out.pendingApprovals.map((a) => a.id)).toEqual(["old", "mid", "new"]);
    expect(out.pendingApprovals[0]).toMatchObject({
      id: "old",
      actionType: "money.payout",
      amount: 500,
      ageSeconds: 3600,
    });
    expect(out.pendingApprovals[2].ageSeconds).toBe(30);
  });

  it("clamps a future-dated approval age to zero (never negative)", () => {
    const out = aggregateFounderConsole(
      input({
        approvals: [
          { id: "future", actionType: "x", summary: "s", amount: null, createdAtMs: NOW + 10_000 },
        ],
      }),
    );
    expect(out.pendingApprovals[0].ageSeconds).toBe(0);
  });

  it("passes the safety switches through read-only", () => {
    const out = aggregateFounderConsole(
      input({
        switches: {
          killSwitch: true,
          maintenance: { enabled: true, since: "2026-06-09T00:00:00Z", reason: "drill" },
        },
      }),
    );
    expect(out.switches.killSwitch).toBe(true);
    expect(out.switches.maintenance).toEqual({
      enabled: true,
      since: "2026-06-09T00:00:00Z",
      reason: "drill",
    });
  });

  it("requires no attention when nothing is pending and all switches are off", () => {
    const out = aggregateFounderConsole(input());
    expect(out.attention).toEqual({ required: false, reasons: [] });
  });

  it("lists every attention reason in priority order", () => {
    const out = aggregateFounderConsole(
      input({
        switches: { killSwitch: true, maintenance: { enabled: true } },
        budget: {
          window: "2026-06",
          estimatedCostCents: 10000,
          budgetCents: 10000,
          computeSeconds: 60,
          sessionsStarted: 9,
        },
        approvals: [
          { id: "a", actionType: "x", summary: "s", amount: null, createdAtMs: NOW - 1000 },
          { id: "b", actionType: "y", summary: "t", amount: null, createdAtMs: NOW - 2000 },
        ],
      }),
    );
    expect(out.attention.required).toBe(true);
    expect(out.attention.reasons).toEqual([
      "kill switch engaged",
      "maintenance mode active",
      "over budget",
      "2 pending approvals",
    ]);
  });

  it("surfaces proactive lifecycle retention work as founder attention (#914)", () => {
    const out = aggregateFounderConsole(
      input({
        lifecycle: {
          dormantWorkspaces: 1,
          highChurnEscalations: 2,
          renewalReminders: 1,
          cancellationOffers: 1,
        },
      }),
    );

    expect(out.attention.reasons).toEqual([
      "1 workspace dormant (retention check due)",
      "2 high-churn signals need same-day escalation",
      "1 renewal need reminder or right-size offer",
      "1 cancellation need save offer",
    ]);
  });

  it("surfaces the #119 autonomy boundaries: classes agents own + the change history", () => {
    const out = aggregateFounderConsole(
      input({
        gateBoundaries: {
          owned: [
            { actionType: "chat.post_message", errorRate: 0.02, windowSize: 100, sinceMs: NOW - 60_000 },
          ],
          history: [
            { actionType: "chat.post_message", direction: "RELAX", errorRate: 0.02, windowSize: 100, atMs: NOW - 60_000, reason: "earned" },
            { actionType: "draft.tweet", direction: "RETIGHTEN", errorRate: 0.2, windowSize: 100, atMs: NOW - 30_000, reason: "regressed" },
          ],
        },
      }),
    );
    expect(out.autonomyBoundaries.owned).toEqual([
      { actionType: "chat.post_message", errorRate: 0.02, windowSize: 100, sinceMs: NOW - 60_000 },
    ]);
    expect(out.autonomyBoundaries.history).toHaveLength(2);
    expect(out.autonomyBoundaries.history[0]).toMatchObject({
      actionType: "chat.post_message",
      direction: "RELAX",
      errorRate: 0.02,
    });
  });

  it("has empty autonomy boundaries by default (no class auto-relaxed yet)", () => {
    const out = aggregateFounderConsole(input());
    expect(out.autonomyBoundaries).toEqual({ owned: [], history: [] });
  });

  it("surfaces a cost forecast projected from the usage trend (#113)", () => {
    const out = aggregateFounderConsole(
      input({
        forecastWindow: "2026-07",
        usageTrend: [
          { window: "2026-04", computeSeconds: 600, estimatedCostCents: 1000, sessionsStarted: 4 },
          { window: "2026-05", computeSeconds: 900, estimatedCostCents: 1500, sessionsStarted: 6 },
          { window: "2026-06", computeSeconds: 1200, estimatedCostCents: 2000, sessionsStarted: 8 },
        ],
      }),
    );
    expect(out.costForecast.window).toBe("2026-07");
    expect(out.costForecast.basis).toBe("trend");
    expect(out.costForecast.projectedCostCents).toBe(2500);
  });

  it("recommends right-sizing from live tenant utilization (#113)", () => {
    const up = aggregateFounderConsole(
      input({ fleet: { tenantInFlight: 9, globalInFlight: 9, sessionsThisWindow: 0 }, tenantConcurrency: 10 }),
    );
    expect(up.costForecast.rightSizing.recommendation).toBe("scale_up");

    const down = aggregateFounderConsole(
      input({ fleet: { tenantInFlight: 1, globalInFlight: 1, sessionsThisWindow: 0 }, tenantConcurrency: 10 }),
    );
    expect(down.costForecast.rightSizing.recommendation).toBe("scale_down");
  });

  it("flags an infra-budget-ceiling breach and raises it to attention (#113, #108)", () => {
    const out = aggregateFounderConsole(
      input({
        forecastWindow: "2026-07",
        infraBudgetCeilingCents: 1500,
        usageTrend: [
          { window: "2026-05", computeSeconds: 900, estimatedCostCents: 1500, sessionsStarted: 6 },
          { window: "2026-06", computeSeconds: 1200, estimatedCostCents: 2000, sessionsStarted: 8 },
        ],
      }),
    );
    expect(out.costForecast.infraBudget.exceeded).toBe(true);
    expect(out.attention.required).toBe(true);
    expect(out.attention.reasons).toContain("infra budget ceiling projected breach");
  });

  it("does not warn on infra budget when no ceiling is set", () => {
    const out = aggregateFounderConsole(
      input({
        usageTrend: [
          { window: "2026-06", computeSeconds: 1200, estimatedCostCents: 9_999_999, sessionsStarted: 8 },
        ],
      }),
    );
    expect(out.costForecast.infraBudget.exceeded).toBe(false);
    expect(out.attention.reasons).not.toContain("infra budget ceiling projected breach");
  });

  it("singularizes the pending-approval reason for exactly one item", () => {
    const out = aggregateFounderConsole(
      input({
        approvals: [{ id: "a", actionType: "x", summary: "s", amount: null, createdAtMs: NOW - 1000 }],
      }),
    );
    expect(out.attention.reasons).toEqual(["1 pending approval"]);
  });

  it("defaults SRE postmortems to an empty list when none are supplied (#112)", () => {
    expect(aggregateFounderConsole(input()).postmortems).toEqual([]);
  });

  it("surfaces SRE postmortems newest-first (#112)", () => {
    const out = aggregateFounderConsole(
      input({
        postmortems: [
          { incidentId: "i1", service: "api", sloKind: "latency_p95", path: "docs/postmortems/a.md", resolvedAtMs: NOW - 5000 },
          { incidentId: "i2", service: "redis", sloKind: "availability", path: "docs/postmortems/b.md", resolvedAtMs: NOW - 1000 },
        ],
      }),
    );
    expect(out.postmortems.map((p) => p.incidentId)).toEqual(["i2", "i1"]);
  });

  it("zeroes the constitution view and stays quiet when none are supplied (#146)", () => {
    const out = aggregateFounderConsole(input());
    expect(out.constitution).toEqual({ openViolations: 0, topCodes: [] });
    expect(out.attention.reasons).not.toContain("1 constitution violation flagged");
  });

  it("flags open constitution violations on the attention list (#146)", () => {
    const out = aggregateFounderConsole(
      input({ constitution: { openViolations: 2, topCodes: ["love_paradigm_unmet", "funded_on_synthetic_demand"] } }),
    );
    expect(out.constitution.openViolations).toBe(2);
    expect(out.attention.required).toBe(true);
    expect(out.attention.reasons).toContain("2 constitution violations flagged");
  });

  it("zeroes the portfolio pane when no reviews are supplied (#107)", () => {
    const out = aggregateFounderConsole(input());
    expect(out.portfolio).toMatchObject({ enabled: false, reviewed: 0, sunset: 0, ventures: [] });
  });

  it("counts the latest review per venture by decision and surfaces the sunset queue (#107)", () => {
    const out = aggregateFounderConsole(
      input({
        portfolioEnabled: true,
        portfolio: [
          // v1 has two reviews — the newer (SUNSET, pending) is the one that counts.
          { ventureIdeaId: "v1", decision: "MAINTAIN", status: "recorded", score: 40, netCents: 0, createdAtMs: NOW - 9000 },
          { ventureIdeaId: "v1", decision: "SUNSET", status: "sunset_pending", score: 10, netCents: -500, createdAtMs: NOW - 1000 },
          { ventureIdeaId: "v2", decision: "DOUBLE_DOWN", status: "recorded", score: 85, netCents: 9000, createdAtMs: NOW - 2000 },
          { ventureIdeaId: "v3", decision: "SUNSET", status: "recorded", score: 15, netCents: -200, createdAtMs: NOW - 3000 },
        ],
      }),
    );
    expect(out.portfolio.reviewed).toBe(3);
    expect(out.portfolio.doubleDown).toBe(1);
    expect(out.portfolio.sunset).toBe(2);
    expect(out.portfolio.sunsetsPendingApproval).toBe(1); // v1
    expect(out.portfolio.sunsetsRecommended).toBe(1); // v3 (SUNSET still 'recorded')
    expect(out.attention.required).toBe(true);
    expect(out.attention.reasons).toEqual(
      expect.arrayContaining([
        "1 venture sunset awaiting approval",
        "1 venture recommended for sunset",
      ]),
    );
  });

  it("never raises portfolio attention while the loop is disabled (#107 default OFF)", () => {
    const out = aggregateFounderConsole(
      input({
        portfolioEnabled: false,
        portfolio: [
          { ventureIdeaId: "v1", decision: "SUNSET", status: "sunset_pending", score: 5, netCents: -900, createdAtMs: NOW },
        ],
      }),
    );
    expect(out.portfolio.sunsetsPendingApproval).toBe(1); // still reported
    expect(out.attention.reasons).not.toContain("1 venture sunset awaiting approval");
  });

  it("always renders the eight-tile proof scorecard, all 'not connected' when no readings are supplied (#253)", () => {
    const out = aggregateFounderConsole(input());
    expect(out.proofScorecard.total).toBe(8);
    expect(out.proofScorecard.connectedCount).toBe(0);
    expect(out.proofScorecard.tiles.every((t) => t.connection === "not_connected")).toBe(true);
  });

  it("flows the gathered per-department proof readings through to the scorecard (#253)", () => {
    const out = aggregateFounderConsole(
      input({
        proofReadings: [
          {
            department: "content",
            connected: true,
            current: 5,
            prior: 2,
            unit: "count",
            source: "Published artifacts (#231)",
          },
        ],
      }),
    );
    expect(out.proofScorecard.connectedCount).toBe(1);
    const content = out.proofScorecard.tiles.find((t) => t.department === "content")!;
    expect(content.value).toBe(5);
    expect(content.trend).toBe("up");
    expect(content.delta).toBe(3);
  });

  it("defaults agent observability to unknown instead of green when the stream is unwired (#1292)", () => {
    const out = aggregateFounderConsole(input());

    expect(out.agentObservability.scheduler.status).toBe("unknown");
    expect(out.agentObservability.audit.coverage).toBeNull();
    expect(out.agentObservability.alerts).toContain("Agent observability stream is not wired yet");
    expect(out.attention.reasons).not.toContain("0 tool calls missing audit events");
  });

  it("raises founder attention for stalled runs, unaudited tools, silent connectors, and recovery handoff (#1292)", () => {
    const out = aggregateFounderConsole(
      input({
        agentObservability: {
          scheduler: { status: "stopped", lastTickAgeSeconds: 900 },
          queueDepth: 12,
          runningRuns: 3,
          stalledRuns: 2,
          failedRunsLast24h: 4,
          retryRate: 0.25,
          recovery: { state: "needs_human", retryableStuckRuns: 2, lastRecoveryAtMs: NOW - 60_000 },
          audit: { toolCalls: 10, auditedToolCalls: 8, unauditedToolCalls: 2, coverage: 0.8 },
          connectorSilentFailures: [{ connector: "Google Ads", status: "silent", lastOkAgeSeconds: 7200 }],
          alerts: ["Google Ads has not emitted a success receipt in 2h"],
        },
      }),
    );

    expect(out.agentObservability.audit.coverage).toBe(0.8);
    expect(out.attention.required).toBe(true);
    expect(out.attention.reasons).toEqual(
      expect.arrayContaining([
        "agent scheduler stopped",
        "2 agent runs stalled",
        "2 tool calls missing audit events",
        "1 connector silently failing",
        "agent recovery needs a human",
      ]),
    );
  });

  it("surfaces per-artifact attributed revenue sorted by receipted dollars (#868)", () => {
    const out = aggregateFounderConsole(
      input({
        attribution: {
          totalAttributedCents: 16400,
          attributedPaymentCount: 4,
          unattributedPaymentCount: 2,
          topArtifacts: [
            {
              artifactId: "https://example.com/pricing",
              artifactKind: "seo_page",
              channel: "seo",
              attributedCents: 4200,
              currency: "usd",
              paymentCount: 1,
            },
            {
              artifactId: "post-1",
              artifactKind: "social_post",
              channel: "social",
              attributedCents: 12200,
              currency: "usd",
              paymentCount: 3,
            },
          ],
        },
      }),
    );

    expect(out.attribution.totalAttributedCents).toBe(16400);
    expect(out.attribution.attributedPaymentCount).toBe(4);
    expect(out.attribution.unattributedPaymentCount).toBe(2);
    expect(out.attribution.topArtifacts.map((a) => a.artifactId)).toEqual([
      "post-1",
      "https://example.com/pricing",
    ]);
  });
});
