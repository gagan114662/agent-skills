import { describe, it, expect } from "vitest";
import {
  resolveRunTimeoutCaps,
  RUN_TIMEOUT_DEFAULTS,
  DEFAULT_RUN_TIMEOUT_MS,
  DEFAULT_STEP_TIMEOUT_MS,
  DEFAULT_SWEEP_INTERVAL_MS,
} from "../../src/run-timeout/caps.js";

describe("resolveRunTimeoutCaps", () => {
  it("defaults OFF with the documented budgets when the environment is empty", () => {
    const caps = resolveRunTimeoutCaps({});
    expect(caps).toEqual({
      enabled: false,
      runTimeoutMs: DEFAULT_RUN_TIMEOUT_MS,
      stepTimeoutMs: DEFAULT_STEP_TIMEOUT_MS,
      sweepIntervalMs: DEFAULT_SWEEP_INTERVAL_MS,
    });
    expect(caps).toEqual(RUN_TIMEOUT_DEFAULTS);
  });

  it("parses boolean-ish enable flags case-insensitively", () => {
    for (const raw of ["1", "true", "TRUE", "yes", "on", " On "]) {
      expect(resolveRunTimeoutCaps({ RUN_TIMEOUT_ENABLED: raw }).enabled).toBe(true);
    }
    for (const raw of ["0", "false", "no", "off", "", "nope"]) {
      expect(resolveRunTimeoutCaps({ RUN_TIMEOUT_ENABLED: raw }).enabled).toBe(false);
    }
  });

  it("reads positive integer ms budgets", () => {
    const caps = resolveRunTimeoutCaps({
      RUN_TIMEOUT_ENABLED: "1",
      RUN_TIMEOUT_RUN_MS: "60000",
      RUN_TIMEOUT_STEP_MS: "15000",
      RUN_TIMEOUT_SWEEP_INTERVAL_MS: "5000",
    });
    expect(caps).toEqual({ enabled: true, runTimeoutMs: 60000, stepTimeoutMs: 15000, sweepIntervalMs: 5000 });
  });

  it("falls back to defaults for missing, non-numeric, zero, or negative values", () => {
    for (const bad of ["abc", "0", "-1", "  ", "NaN"]) {
      const caps = resolveRunTimeoutCaps({ RUN_TIMEOUT_RUN_MS: bad, RUN_TIMEOUT_STEP_MS: bad });
      expect(caps.runTimeoutMs).toBe(DEFAULT_RUN_TIMEOUT_MS);
      expect(caps.stepTimeoutMs).toBe(DEFAULT_STEP_TIMEOUT_MS);
    }
  });

  it("truncates fractional ms to an integer", () => {
    expect(resolveRunTimeoutCaps({ RUN_TIMEOUT_RUN_MS: "1234.9" }).runTimeoutMs).toBe(1234);
  });
});
