import { describe, it, expect } from "vitest";
import { resolveReliabilityCaps, RELIABILITY_DEFAULTS } from "../../src/reliability/caps.js";

describe("resolveReliabilityCaps", () => {
  it("defaults everything OFF/safe when no config is set", () => {
    const caps = resolveReliabilityCaps(undefined);
    expect(caps.enabled).toBe(false);
    expect(caps.statusPageEnabled).toBe(false);
    expect(caps.quietHours).toBeNull();
    expect(caps.maxPagesPerHour).toBe(RELIABILITY_DEFAULTS.maxPagesPerHour);
    expect(caps.escalateAfterMs).toBe(RELIABILITY_DEFAULTS.escalateAfterMs);
    expect(caps.pageOnResolve).toBe(true);
    expect(caps.deployWindowMs).toBe(RELIABILITY_DEFAULTS.deployWindowMs);
  });

  it("passes through an enabled config with explicit knobs", () => {
    const caps = resolveReliabilityCaps({
      enabled: true,
      statusPageEnabled: true,
      maxPagesPerHour: 3,
      escalateAfterMs: 600_000,
      pageOnResolve: false,
      deployWindowMs: 120_000,
    });
    expect(caps.enabled).toBe(true);
    expect(caps.statusPageEnabled).toBe(true);
    expect(caps.maxPagesPerHour).toBe(3);
    expect(caps.escalateAfterMs).toBe(600_000);
    expect(caps.pageOnResolve).toBe(false);
    expect(caps.deployWindowMs).toBe(120_000);
  });

  it("builds a quiet-hours window only when both bounds are set and differ", () => {
    expect(resolveReliabilityCaps({ quietHoursStartHourUtc: 22, quietHoursEndHourUtc: 6 }).quietHours).toEqual({
      startHourUtc: 22,
      endHourUtc: 6,
    });
    expect(resolveReliabilityCaps({ quietHoursStartHourUtc: 22 }).quietHours).toBeNull(); // end missing
    expect(resolveReliabilityCaps({ quietHoursStartHourUtc: 5, quietHoursEndHourUtc: 5 }).quietHours).toBeNull();
  });
});
