import { describe, it, expect } from "vitest";
import {
  composePremortemPanel,
  type PremortemPanelInput,
} from "../../src/founder-briefings/aggregate.js";

function input(over: Partial<PremortemPanelInput> = {}): PremortemPanelInput {
  return {
    venturesWithEdge: 2,
    totalVentures: 2,
    externallyVerifiedMetrics: 4,
    totalMetrics: 4,
    irreversibleActionCount: 0,
    decisionsPresented: 3,
    attentionBudget: 3,
    approvalsDecided: 5,
    approvalsRubberStamped: 0,
    ownerOverrides: 0,
    ...over,
  };
}

describe("composePremortemPanel (#200 AC2)", () => {
  it("reads all-green with full edge coverage and verified metrics", () => {
    const p = composePremortemPanel(input());
    expect(p.edgeCoveragePct).toBe(100);
    expect(p.externallyVerifiedPct).toBe(100);
    expect(p.flags).toEqual([]);
  });

  it("flags ventures without a falsifiable edge (FM#1)", () => {
    const p = composePremortemPanel(input({ venturesWithEdge: 1, totalVentures: 3 }));
    expect(p.edgeCoveragePct).toBe(33);
    expect(p.flags.some((f) => f.includes("without a falsifiable edge"))).toBe(true);
  });

  it("flags self-reported metrics (FM#2)", () => {
    const p = composePremortemPanel(input({ externallyVerifiedMetrics: 1, totalMetrics: 4 }));
    expect(p.externallyVerifiedPct).toBe(25);
    expect(p.flags.some((f) => f.includes("self-reported"))).toBe(true);
  });

  it("flags owner attention over budget (FM#5)", () => {
    const p = composePremortemPanel(input({ decisionsPresented: 7, attentionBudget: 3 }));
    expect(p.attentionSpend.overBudget).toBe(true);
    expect(p.flags.some((f) => f.includes("attention over budget"))).toBe(true);
  });

  it("flags a high rubber-stamp rate as gate theater (FM#5)", () => {
    const p = composePremortemPanel(input({ approvalsDecided: 5, approvalsRubberStamped: 5 }));
    expect(p.rubberStampRatePct).toBe(100);
    expect(p.flags.some((f) => f.includes("theater"))).toBe(true);
  });

  it("computes the override rate (the taste gap, FM#7)", () => {
    const p = composePremortemPanel(input({ approvalsDecided: 4, ownerOverrides: 1 }));
    expect(p.overrideRatePct).toBe(25);
  });

  it("treats zero ventures/metrics as 100% (vacuously healthy)", () => {
    const p = composePremortemPanel(input({ venturesWithEdge: 0, totalVentures: 0, externallyVerifiedMetrics: 0, totalMetrics: 0 }));
    expect(p.edgeCoveragePct).toBe(100);
    expect(p.externallyVerifiedPct).toBe(100);
    expect(p.flags).toEqual([]);
  });
});
