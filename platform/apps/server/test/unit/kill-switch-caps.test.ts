import { describe, it, expect } from "vitest";
import { resolveKillSwitchCaps, KILL_SWITCH_DEFAULTS } from "../../src/kill-switch/caps.js";

describe("resolveKillSwitchCaps", () => {
  it("defaults OFF with no tripwires when the environment is empty", () => {
    const caps = resolveKillSwitchCaps({});
    expect(caps).toEqual(KILL_SWITCH_DEFAULTS);
    expect(caps.enabled).toBe(false);
    expect(caps.thresholds).toEqual({
      maxSpendPerHourCents: null,
      maxErrorRateBps: null,
      maxBounceRateBps: null,
    });
  });

  it("parses boolean-ish enable flags case-insensitively", () => {
    for (const raw of ["1", "true", "TRUE", "yes", "on", " On "]) {
      expect(resolveKillSwitchCaps({ KILL_SWITCH_ENABLED: raw }).enabled).toBe(true);
    }
    for (const raw of ["0", "false", "no", "off", "", "nope"]) {
      expect(resolveKillSwitchCaps({ KILL_SWITCH_ENABLED: raw }).enabled).toBe(false);
    }
  });

  it("reads positive integer tripwire ceilings", () => {
    const caps = resolveKillSwitchCaps({
      KILL_SWITCH_MAX_SPEND_PER_HOUR_CENTS: "50000",
      KILL_SWITCH_MAX_ERROR_RATE_BPS: "2500",
      KILL_SWITCH_MAX_BOUNCE_RATE_BPS: "4000",
    });
    expect(caps.thresholds).toEqual({
      maxSpendPerHourCents: 50_000,
      maxErrorRateBps: 2_500,
      maxBounceRateBps: 4_000,
    });
  });

  it("leaves a metric unmonitored for missing, blank, non-numeric, zero, or negative ceilings", () => {
    for (const bad of ["", "   ", "abc", "0", "-100", "NaN"]) {
      expect(resolveKillSwitchCaps({ KILL_SWITCH_MAX_SPEND_PER_HOUR_CENTS: bad }).thresholds
        .maxSpendPerHourCents).toBeNull();
    }
  });

  it("truncates a fractional ceiling to an integer", () => {
    expect(
      resolveKillSwitchCaps({ KILL_SWITCH_MAX_ERROR_RATE_BPS: "2500.9" }).thresholds.maxErrorRateBps,
    ).toBe(2_500);
  });

  it("can be enabled with no ceilings (a manual-only global kill-switch)", () => {
    const caps = resolveKillSwitchCaps({ KILL_SWITCH_ENABLED: "1" });
    expect(caps.enabled).toBe(true);
    expect(caps.thresholds.maxSpendPerHourCents).toBeNull();
  });
});
