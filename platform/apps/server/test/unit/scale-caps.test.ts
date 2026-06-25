import { describe, it, expect } from "vitest";
import { resolveScaleCaps } from "../../src/scale/caps.js";

describe("scale/caps (#71 — per-tenant scale policy defaults)", () => {
  it("defaults everything to off when no scale config is set (preserves #25 behavior)", () => {
    expect(resolveScaleCaps(undefined)).toEqual({
      warmPoolSize: 0,
      regions: [],
      preferredRegion: undefined,
      tenantConcurrency: 0,
      budgetCents: 0,
      computeRateCentsPerMinute: 0,
      infraBudgetCeilingCents: 0,
    });
  });

  it("passes configured values through and copies the regions array", () => {
    const regions = ["iad1", "sfo1"];
    const caps = resolveScaleCaps({
      warmPoolSize: 2,
      regions,
      preferredRegion: "sfo1",
      tenantConcurrency: 5,
      budgetCents: 5000,
      computeRateCentsPerMinute: 2,
      infraBudgetCeilingCents: 20000,
    });
    expect(caps).toEqual({
      warmPoolSize: 2,
      regions: ["iad1", "sfo1"],
      preferredRegion: "sfo1",
      tenantConcurrency: 5,
      budgetCents: 5000,
      computeRateCentsPerMinute: 2,
      infraBudgetCeilingCents: 20000,
    });
    expect(caps.regions).not.toBe(regions); // defensive copy — caller's array is not aliased
  });

  it("uses an active paid plan budget over the trial/config budget (#873)", () => {
    expect(
      resolveScaleCaps(
        { budgetCents: 500, tenantConcurrency: 2 },
        { status: "active", monthlySessionBudgetCents: 100_000 },
      ),
    ).toMatchObject({ budgetCents: 100_000, tenantConcurrency: 2 });
  });
});
