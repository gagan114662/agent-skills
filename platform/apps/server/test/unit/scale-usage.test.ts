import { describe, it, expect } from "vitest";
import {
  windowKey,
  estimateCostCents,
  budgetExceeded,
  EMPTY_USAGE,
} from "../../src/scale/usage.js";

describe("scale/usage (#71 — pure cost + window math)", () => {
  it("windowKey is the UTC YYYY-MM of the date", () => {
    expect(windowKey(new Date("2026-06-09T12:00:00Z"))).toBe("2026-06");
    expect(windowKey(new Date("2026-01-31T23:59:59Z"))).toBe("2026-01");
    // January (month 0) is zero-padded
    expect(windowKey(new Date("2026-12-01T00:00:00Z"))).toBe("2026-12");
  });

  it("estimateCostCents rounds compute-minutes times the rate", () => {
    expect(estimateCostCents(60, 2)).toBe(2); // 1 minute @ 2c
    expect(estimateCostCents(90, 2)).toBe(3); // 1.5 minutes @ 2c
    expect(estimateCostCents(30, 2)).toBe(1); // 0.5 minute → round(1) = 1
  });

  it("estimateCostCents is zero when the rate or seconds are non-positive (default = free)", () => {
    expect(estimateCostCents(600, 0)).toBe(0); // rate 0 → no cost (opt-in budget off)
    expect(estimateCostCents(0, 5)).toBe(0);
    expect(estimateCostCents(-10, 5)).toBe(0);
  });

  it("budgetExceeded only bites when a positive cap is met or passed", () => {
    expect(budgetExceeded(0, 0)).toBe(false); // no cap configured
    expect(budgetExceeded(10_000, 0)).toBe(false); // no cap → never exceeded
    expect(budgetExceeded(4999, 5000)).toBe(false);
    expect(budgetExceeded(5000, 5000)).toBe(true); // at the cap halts
    expect(budgetExceeded(5001, 5000)).toBe(true);
  });

  it("EMPTY_USAGE is all zeros (a tenant with no recorded usage this window)", () => {
    expect(EMPTY_USAGE).toEqual({
      sessionsStarted: 0,
      computeSeconds: 0,
      estimatedCostCents: 0,
    });
  });
});
