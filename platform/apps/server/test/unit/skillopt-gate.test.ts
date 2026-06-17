import { describe, it, expect } from "vitest";
import { decideAdoption, orientedImprovement, improvementRatio } from "../../src/skillopt/gate.js";
import type { ValidationReading } from "../../src/skillopt/contract.js";

function reading(over: Partial<ValidationReading> = {}): ValidationReading {
  return {
    metric: "seo.click_through",
    higherIsBetter: true,
    baseline: 100,
    candidate: 120,
    sampleSize: 10,
    externallyVerified: true,
    ...over,
  };
}

describe("skillopt/gate — orientation", () => {
  it("orients improvement so positive always means better", () => {
    expect(orientedImprovement(reading({ baseline: 100, candidate: 120 }))).toBe(20);
    // lower-is-better (e.g. CAC): a drop is an improvement
    expect(orientedImprovement(reading({ higherIsBetter: false, baseline: 50, candidate: 40 }))).toBe(10);
  });

  it("computes a scale-free improvement ratio", () => {
    expect(improvementRatio(reading({ baseline: 100, candidate: 110 }))).toBeCloseTo(0.1);
    expect(improvementRatio(reading({ baseline: 0, candidate: 5 }))).toBe(Number.POSITIVE_INFINITY);
  });
});

describe("skillopt/gate — decideAdoption", () => {
  it("REJECTS a self-reported (not externally verified) reading — #200 §2", () => {
    const d = decideAdoption(reading({ externallyVerified: false }));
    expect(d.adopt).toBe(false);
    expect(d.reason).toMatch(/not externally verified/);
  });

  it("REJECTS a held-out set that is too small", () => {
    const d = decideAdoption(reading({ sampleSize: 2 }), { minSampleSize: 5 });
    expect(d.adopt).toBe(false);
    expect(d.reason).toMatch(/too small/);
  });

  it("REJECTS a tie (no strict improvement)", () => {
    const d = decideAdoption(reading({ baseline: 100, candidate: 100 }));
    expect(d.adopt).toBe(false);
    expect(d.reason).toMatch(/did not strictly improve/);
  });

  it("REJECTS a regression", () => {
    const d = decideAdoption(reading({ baseline: 100, candidate: 90 }));
    expect(d.adopt).toBe(false);
  });

  it("REJECTS an improvement below the margin", () => {
    const d = decideAdoption(reading({ baseline: 100, candidate: 102 }), { minImprovementRatio: 0.05 });
    expect(d.adopt).toBe(false);
    expect(d.reason).toMatch(/below the/);
  });

  it("ADOPTS a strict improvement above the margin on externally-verified samples", () => {
    const d = decideAdoption(reading({ baseline: 100, candidate: 120 }), { minImprovementRatio: 0.05 });
    expect(d.adopt).toBe(true);
    expect(d.improvementRatio).toBeCloseTo(0.2);
  });

  it("ADOPTS a lower-is-better metric that improved (CAC dropped)", () => {
    const d = decideAdoption(
      reading({ metric: "cac", higherIsBetter: false, baseline: 50, candidate: 40 }),
      { minImprovementRatio: 0.05 },
    );
    expect(d.adopt).toBe(true);
  });
});
