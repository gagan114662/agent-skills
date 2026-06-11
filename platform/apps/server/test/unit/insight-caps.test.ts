import { describe, it, expect } from "vitest";
import { INSIGHT_DEFAULTS, resolveInsightCaps } from "../../src/insight/caps.js";

describe("resolveInsightCaps", () => {
  it("defaults to OFF with hard defaults when no config is supplied", () => {
    const caps = resolveInsightCaps(undefined);
    expect(caps).toEqual(INSIGHT_DEFAULTS);
    expect(caps.enabled).toBe(false);
  });

  it("overrides only the fields the config sets, keeping defaults for the rest", () => {
    const caps = resolveInsightCaps({ enabled: true, mineCostCents: 250 });
    expect(caps.enabled).toBe(true);
    expect(caps.mineCostCents).toBe(250);
    expect(caps.freshnessHalfLifeDays).toBe(INSIGHT_DEFAULTS.freshnessHalfLifeDays);
    expect(caps.minSourceStrength).toBe(INSIGHT_DEFAULTS.minSourceStrength);
  });
});
