import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { AutonomousVentureLoopProof } from "../../src/venture-loop/proof.js";
import {
  formatAutonomousVentureLoopProofReport,
  loadAutonomousVentureLoopProofJson,
  parseAutonomousVentureLoopProofCliConfig,
  type AutonomousVentureLoopProofCliConfig,
} from "../../src/venture-loop/proof-cli.js";

const completeProof: AutonomousVentureLoopProof = {
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

describe("autonomous venture-loop proof CLI (#403)", () => {
  it("parses --file and -f", () => {
    expect(parseAutonomousVentureLoopProofCliConfig(["--file", "proof.json"])).toEqual({ file: "proof.json" });
    expect(parseAutonomousVentureLoopProofCliConfig(["-f=proof.json"])).toEqual({ file: "proof.json" });
  });

  it("loads proof JSON from a file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "autonomous-venture-loop-proof-"));
    const file = join(dir, "proof.json");
    await writeFile(file, JSON.stringify(completeProof), "utf8");

    await expect(loadAutonomousVentureLoopProofJson({ file })).resolves.toMatchObject({
      start: { ventureId: "venture_123" },
      earn: { providerEventId: "evt_venture_revenue_123" },
    });
  });

  it("formats a passing proof report", () => {
    expect(formatAutonomousVentureLoopProofReport(completeProof)).toEqual([
      "PASS autonomous-venture-loop-proof: start -> earn -> learn -> kill/scale -> repeat -> safety proven",
    ]);
  });

  it("fails closed with actionable gaps for one-off human-driven claims", () => {
    const lines = formatAutonomousVentureLoopProofReport({
      ...completeProof,
      start: {
        ...completeProof.start,
        backgroundTickEnabled: false,
        tickIntervalMs: 0,
      },
      earn: {
        ...completeProof.earn,
        provider: "manual_claim",
        providerEventId: "",
        amountCents: 0,
      },
      loop: {
        ...completeProof.loop,
        autonomousTickCount: 1,
        humanInterventionCount: 1,
      },
      safety: {
        ...completeProof.safety,
        killSwitchArmed: false,
        hardSpendCapCents: 0,
        spentCents: 1,
        capRaiseApprovalRequired: false,
      },
    });

    expect(lines[0]).toBe("FAIL autonomous-venture-loop-proof: 5 gap(s)");
    expect(lines).toEqual(
      expect.arrayContaining([
        expect.stringContaining("FAIL start_company:"),
        expect.stringContaining("FAIL earn_real_money:"),
        expect.stringContaining("FAIL autonomous_loop:"),
        expect.stringContaining("FAIL bounded_safety:"),
      ]),
    );
  });

  it("requires a proof JSON body", async () => {
    const readStdin = async () => "   ";
    await expect(
      loadAutonomousVentureLoopProofJson({ file: "", readStdin } as AutonomousVentureLoopProofCliConfig),
    ).rejects.toThrow("autonomous-venture-loop proof JSON is required");
  });
});
