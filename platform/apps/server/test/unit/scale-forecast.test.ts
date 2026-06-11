import { describe, it, expect } from "vitest";
import {
  forecastUsage,
  recommendRightSizing,
  infraBudgetStatus,
  type UsageTrendPoint,
} from "../../src/scale/forecast.js";

function pt(window: string, computeSeconds: number, estimatedCostCents: number, sessionsStarted = 0): UsageTrendPoint {
  return { window, computeSeconds, estimatedCostCents, sessionsStarted };
}

describe("forecastUsage (the pure cost projection from tenant_usage trend)", () => {
  it("projects zeros with basis 'empty' for no history", () => {
    const f = forecastUsage([], "2026-07");
    expect(f).toEqual({
      window: "2026-07",
      projectedComputeSeconds: 0,
      projectedCostCents: 0,
      projectedSessionsStarted: 0,
      basis: "empty",
      momChangePct: null,
    });
  });

  it("projects a flat continuation with basis 'flat' for a single observed window", () => {
    const f = forecastUsage([pt("2026-06", 600, 1000, 12)], "2026-07");
    expect(f.basis).toBe("flat");
    expect(f.projectedComputeSeconds).toBe(600);
    expect(f.projectedCostCents).toBe(1000);
    expect(f.projectedSessionsStarted).toBe(12);
    expect(f.momChangePct).toBeNull();
  });

  it("linearly projects a rising trend (last + average delta) with basis 'trend'", () => {
    // cost deltas: +500, +500 → projected next = 2000 + 500 = 2500
    const f = forecastUsage(
      [pt("2026-04", 600, 1000), pt("2026-05", 900, 1500), pt("2026-06", 1200, 2000)],
      "2026-07",
    );
    expect(f.basis).toBe("trend");
    expect(f.projectedCostCents).toBe(2500);
    expect(f.projectedComputeSeconds).toBe(1500); // +300 avg delta
    // forecast growth vs last observed cost: (2500-2000)/2000 = 0.25
    expect(f.momChangePct).toBeCloseTo(0.25, 5);
  });

  it("clamps a falling trend so a projection never goes negative", () => {
    // cost: 1000 → 400 → 100, avg delta = -450, last + delta = -350 → clamped to 0
    const f = forecastUsage(
      [pt("2026-04", 100, 1000), pt("2026-05", 40, 400), pt("2026-06", 10, 100)],
      "2026-07",
    );
    expect(f.basis).toBe("trend");
    expect(f.projectedCostCents).toBe(0);
    expect(f.projectedComputeSeconds).toBe(0);
  });

  it("uses only the most recent 3 points for the slope (recency-weighted)", () => {
    // an old spike must not drag the projection — only the last 3 (flat at 100) count
    const f = forecastUsage(
      [
        pt("2026-02", 9999, 99999),
        pt("2026-03", 50, 100),
        pt("2026-04", 50, 100),
        pt("2026-05", 50, 100),
      ],
      "2026-06",
    );
    expect(f.projectedCostCents).toBe(100); // flat last 3 → delta 0
  });

  it("orders the trend by window before projecting (input order independent)", () => {
    const ordered = forecastUsage(
      [pt("2026-04", 600, 1000), pt("2026-05", 900, 1500), pt("2026-06", 1200, 2000)],
      "2026-07",
    );
    const shuffled = forecastUsage(
      [pt("2026-06", 1200, 2000), pt("2026-04", 600, 1000), pt("2026-05", 900, 1500)],
      "2026-07",
    );
    expect(shuffled).toEqual(ordered);
  });

  it("returns null momChangePct when the last observed cost is zero (no base to grow from)", () => {
    const f = forecastUsage([pt("2026-05", 0, 0), pt("2026-06", 0, 0)], "2026-07");
    expect(f.projectedCostCents).toBe(0);
    expect(f.momChangePct).toBeNull();
  });
});

describe("recommendRightSizing (utilization-driven scale call)", () => {
  it("recommends scale_up when tenant in-flight saturates the concurrency cap", () => {
    const r = recommendRightSizing({ tenantInFlight: 9, tenantConcurrency: 10 });
    expect(r.recommendation).toBe("scale_up");
    expect(r.utilization).toBeCloseTo(0.9, 5);
  });

  it("recommends scale_down when utilization is low and the cap could shrink", () => {
    const r = recommendRightSizing({ tenantInFlight: 1, tenantConcurrency: 10 });
    expect(r.recommendation).toBe("scale_down");
    expect(r.utilization).toBeCloseTo(0.1, 5);
  });

  it("holds in the comfortable middle band", () => {
    const r = recommendRightSizing({ tenantInFlight: 5, tenantConcurrency: 10 });
    expect(r.recommendation).toBe("hold");
  });

  it("holds with null utilization when no positive concurrency cap is set", () => {
    const r = recommendRightSizing({ tenantInFlight: 3, tenantConcurrency: 0 });
    expect(r.recommendation).toBe("hold");
    expect(r.utilization).toBeNull();
  });

  it("never recommends shrinking a cap that is already at 1", () => {
    const r = recommendRightSizing({ tenantInFlight: 0, tenantConcurrency: 1 });
    expect(r.recommendation).toBe("hold");
  });
});

describe("infraBudgetStatus (the #108 infra ceiling gate)", () => {
  it("never bites with a zero (unset) ceiling", () => {
    const s = infraBudgetStatus(50_000, 0);
    expect(s.exceeded).toBe(false);
    expect(s.headroomCents).toBeNull();
    expect(s.utilization).toBeNull();
  });

  it("flags a breach when the projection meets or passes a positive ceiling", () => {
    const s = infraBudgetStatus(10_000, 10_000);
    expect(s.exceeded).toBe(true);
    expect(s.headroomCents).toBe(0);
    expect(s.utilization).toBe(1);
  });

  it("reports headroom + utilization under a positive ceiling", () => {
    const s = infraBudgetStatus(4_000, 10_000);
    expect(s.exceeded).toBe(false);
    expect(s.headroomCents).toBe(6_000);
    expect(s.utilization).toBeCloseTo(0.4, 5);
  });
});
