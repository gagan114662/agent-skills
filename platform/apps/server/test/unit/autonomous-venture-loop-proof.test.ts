import { describe, expect, it } from "vitest";
import {
  verifyAutonomousVentureLoopProof,
  type AutonomousVentureLoopProof,
} from "../../src/venture-loop/proof.js";

const baseProof: AutonomousVentureLoopProof = {
  start: {
    ventureId: "venture_123",
    factoryRunId: "factory_run_123",
    deployReceipt: {
      source: "live_url",
      externalRef: "https://venture.example.com",
      httpStatus: 200,
      observedAt: "2026-06-28T03:00:00.000Z",
    },
    backgroundTickEnabled: true,
    tickIntervalMs: 15 * 60 * 1000,
  },
  earn: {
    provider: "stripe",
    providerEventId: "evt_venture_revenue_123",
    amountCents: 12_500,
    currency: "usd",
    receipt: {
      source: "production_readback",
      externalRef: "evt_venture_revenue_123",
      observedAt: "2026-06-28T03:20:00.000Z",
      detail: { provider: "stripe" },
    },
  },
  learn: {
    skillOptRunId: "skillopt_run_123",
    revenueRewardApplied: true,
    demotedNonEarners: true,
    promotedEarners: true,
  },
  portfolio: {
    lifecycleRunId: "portfolio_run_123",
    killDecisionCount: 1,
    scaleDecisionCount: 1,
    usedRevenueReceiptsOnly: true,
  },
  loop: {
    autonomousTickCount: 3,
    humanInterventionCount: 0,
    lastTickReceipt: {
      source: "production_readback",
      externalRef: "venture-loop-tick-003",
      observedAt: "2026-06-28T04:00:00.000Z",
      detail: { scheduler: "venture-loop" },
    },
  },
  safety: {
    killSwitchArmed: true,
    hardSpendCapCents: 25_000,
    spentCents: 12_500,
    capRaiseApprovalRequired: true,
    auditReceipt: {
      source: "production_readback",
      externalRef: "venture-loop-audit-123",
      observedAt: "2026-06-28T04:05:00.000Z",
    },
  },
};

describe("verifyAutonomousVentureLoopProof (#403 close gate)", () => {
  it("passes only when start, earn, learn, kill/scale, loop, and safety proof are all present", () => {
    const result = verifyAutonomousVentureLoopProof(baseProof);

    expect(result.proven).toBe(true);
    expect(result.gaps).toEqual([]);
  });

  it("rejects one-off, human-driven, vanity-metric, or uncapped loop claims", () => {
    const result = verifyAutonomousVentureLoopProof({
      start: {
        ventureId: "",
        factoryRunId: "",
        deployReceipt: {
          source: "live_url",
          externalRef: "https://venture.example.com",
          httpStatus: 503,
          observedAt: "2026-06-28T03:00:00.000Z",
        },
        backgroundTickEnabled: false,
        tickIntervalMs: 0,
      },
      earn: {
        provider: "manual_claim",
        providerEventId: "",
        amountCents: 0,
        currency: "usd",
        receipt: {
          source: "production_readback",
          externalRef: "",
          observedAt: "2026-06-28T03:20:00.000Z",
        },
      },
      learn: {
        skillOptRunId: "",
        revenueRewardApplied: false,
        demotedNonEarners: false,
        promotedEarners: false,
      },
      portfolio: {
        lifecycleRunId: "",
        killDecisionCount: 0,
        scaleDecisionCount: 0,
        usedRevenueReceiptsOnly: false,
      },
      loop: {
        autonomousTickCount: 1,
        humanInterventionCount: 1,
        lastTickReceipt: {
          source: "production_readback",
          externalRef: "",
          observedAt: "2026-06-28T04:00:00.000Z",
        },
      },
      safety: {
        killSwitchArmed: false,
        hardSpendCapCents: 0,
        spentCents: 10_000,
        capRaiseApprovalRequired: false,
        auditReceipt: {
          source: "production_readback",
          externalRef: "",
          observedAt: "2026-06-28T04:05:00.000Z",
        },
      },
    });

    expect(result.proven).toBe(false);
    expect(result.gaps.map((gap) => gap.requirement)).toEqual([
      "start_company",
      "start_company",
      "earn_real_money",
      "earn_real_money",
      "learn_from_revenue",
      "portfolio_kill_scale",
      "portfolio_kill_scale",
      "autonomous_loop",
      "autonomous_loop",
      "bounded_safety",
      "bounded_safety",
      "bounded_safety",
    ]);
  });
});
