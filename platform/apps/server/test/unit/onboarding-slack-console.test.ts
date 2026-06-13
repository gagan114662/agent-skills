import { describe, it, expect } from "vitest";
import { buildSetupChecklistBlocks } from "../../src/slack/blocks.js";
import { aggregateFounderConsole, type FounderConsoleInput } from "../../src/founder-console/aggregate.js";

describe("buildSetupChecklistBlocks (#192 Slack checklist)", () => {
  it("renders a header + one section per item and flags irreversible (money) items", () => {
    const blocks = buildSetupChecklistBlocks({
      items: [
        { displayName: "SendGrid", summary: "Set up SendGrid ~$15.00/mo", reversibility: "cheap" },
        { displayName: "Namecheap", summary: "Set up Namecheap ~$12.00/mo", reversibility: "irreversible" },
      ],
    });
    const json = JSON.stringify(blocks);
    expect(json).toContain("2 external accounts need you");
    expect(json).toContain("SendGrid");
    expect(json).toContain("Namecheap");
    // the irreversible item is flagged as money; the reversible one is not
    const namecheapBlock = blocks.find(
      (b) => typeof (b as { text?: { text?: string } }).text?.text === "string" &&
        (b as { text: { text: string } }).text.text.includes("Namecheap"),
    ) as { text: { text: string } };
    expect(namecheapBlock.text.text).toContain("money");
    const sendgridBlock = blocks.find(
      (b) => typeof (b as { text?: { text?: string } }).text?.text === "string" &&
        (b as { text: { text: string } }).text.text.includes("SendGrid"),
    ) as { text: { text: string } };
    expect(sendgridBlock.text.text).not.toContain("money");
  });

  it("uses the singular for one account", () => {
    const blocks = buildSetupChecklistBlocks({
      items: [{ displayName: "GA4", summary: "Set up GA4 (no cost)", reversibility: "reversible" }],
    });
    expect(JSON.stringify(blocks)).toContain("1 external account need you");
  });
});

/** A minimal valid console input (every required field present, everything zero/empty). */
function baseInput(setup?: FounderConsoleInput["setup"]): FounderConsoleInput {
  return {
    workspaceId: "w1",
    nowMs: 0,
    fleet: { tenantInFlight: 0, globalInFlight: 0, sessionsThisWindow: 0 },
    ventures: [],
    revenue: { currency: "usd", totalCents: 0, paymentCount: 0, evidenceCount: 0 },
    budget: { window: "2026-06", estimatedCostCents: 0, budgetCents: 0, computeSeconds: 0, sessionsStarted: 0 },
    approvals: [],
    switches: { killSwitch: false, maintenance: { enabled: false } },
    gateBoundaries: { owned: [], history: [] },
    usageTrend: [],
    forecastWindow: "2026-07",
    infraBudgetCeilingCents: 0,
    tenantConcurrency: 0,
    setup,
  };
}

describe("founder console setup pane (#192)", () => {
  it("zeroes the pane and adds no attention reason when onboarding is unwired", () => {
    const out = aggregateFounderConsole(baseInput());
    expect(out.setup).toEqual({ pendingSetup: 0, connected: 0, rotationDue: 0, offlineCapabilities: 0 });
    expect(out.attention.reasons).toEqual([]);
  });

  it("surfaces pending setup / rotation / offline as attention reasons", () => {
    const out = aggregateFounderConsole(
      baseInput({ pendingSetup: 2, connected: 3, rotationDue: 1, offlineCapabilities: 1 }),
    );
    expect(out.setup).toEqual({ pendingSetup: 2, connected: 3, rotationDue: 1, offlineCapabilities: 1 });
    expect(out.attention.reasons).toContain("2 external accounts need setup");
    expect(out.attention.reasons).toContain("1 credential due for rotation");
    expect(out.attention.reasons).toContain("1 capability offline (credential revoked)");
    expect(out.attention.required).toBe(true);
  });
});
